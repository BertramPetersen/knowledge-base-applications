import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  loadVault, buildIndex, search, tagCounts, notesByTag,
  parseNote, serializeNote, VaultGit, autoSync,
  type Note, type Vault, type SyncResult,
} from '@kb/core';
import { tauriVault, tauriGit } from './tauriVault.ts';

const ALL = '__all__';

export default function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(() => localStorage.getItem('vault'));
  const [vault, setVault] = useState<Vault | null>(null);
  const [selectedTag, setSelectedTag] = useState(ALL);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The frontend cannot read $HOME, so Rust supplies the default location.
  useEffect(() => {
    if (!vaultPath) void invoke<string>('default_vault').then(setVaultPath).catch((e) => setError(String(e)));
  }, [vaultPath]);

  const source = useMemo(() => (vaultPath ? tauriVault(vaultPath) : null), [vaultPath]);
  const git = useMemo(() => (vaultPath ? new VaultGit(tauriGit(vaultPath)) : null), [vaultPath]);

  const reload = useCallback(async () => {
    if (!source) return;
    try { setVault(await loadVault(source)); setError(null); }
    catch (e) { setError(String(e)); }
  }, [source]);

  useEffect(() => { void reload(); }, [reload]);

  // Pull on launch, then slowly. The enrichment job pushes every two hours, so
  // notes gain tags and links with no action here.
  useEffect(() => {
    if (!git) return;
    const pull = async () => {
      try {
        const r = await git.sync('vault: local edits');
        setStatus(r);
        if (r.pulled) await reload();
      } catch (e) { setStatus({ pulled: 0, pushed: false, committed: null, conflict: false, message: String(e) }); }
    };
    void pull();
    const id = setInterval(pull, 5 * 60_000);
    return () => clearInterval(id);
  }, [git, reload]);

  const syncer = useMemo(
    () => (git ? autoSync(git, 10_000, setStatus) : null),
    [git],
  );
  useEffect(() => () => syncer?.stop(), [syncer]);

  const index = useMemo(() => (vault ? buildIndex(vault) : null), [vault]);
  const counts = useMemo(() => (vault ? tagCounts(vault) : new Map<string, number>()), [vault]);

  const notes: Note[] = useMemo(() => {
    if (!vault) return [];
    if (query.trim() && index) return search(vault, index, query, 50).map((h) => h.note);
    const list = selectedTag === ALL ? [...vault.notes.values()] : notesByTag(vault, selectedTag);
    return [...list].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  }, [vault, index, query, selectedTag]);

  const selected = selectedId ? vault?.notes.get(selectedId) ?? null : null;

  // Load the note into the editor when the selection changes, but never while
  // the user is typing into the one already open.
  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (selected && loadedId.current !== selected.id) {
      loadedId.current = selected.id;
      setDraft(selected.body);
    } else if (!selected) {
      loadedId.current = null;
    }
  }, [selected]);

  const onEdit = (text: string) => {
    setDraft(text);
    if (!selected || !source) return;
    void (async () => {
      // Re-read before writing: the enrichment job may have added tags since
      // this note was loaded, and passing the current text preserves its exact
      // frontmatter order and quoting.
      const previous = await source.read(selected.id);
      const note = parseNote(selected.id, previous);
      await source.write(selected.id, serializeNote({ ...note, body: text }, previous));
      syncer?.touch();
    })().catch((e) => setError(String(e)));
  };

  const newNote = async () => {
    if (!source) return;
    const today = new Date().toISOString().slice(0, 10);
    const id = `raw/${today}-untitled-${Math.random().toString(36).slice(2, 10)}.md`;
    await source.write(id, `---\ncreated: ${today}\n---\n\n`);
    await reload();
    setSelectedId(id);
    setDraft('');
    loadedId.current = id;
  };

  if (!vault) return <div className="empty">{error ?? 'Opening vault…'}</div>;

  const topics = [...vault.tags.values()].filter((t) => t.kind === 'topic');

  return (
    <div className="app">
      <nav className="pane sidebar">
        <button className="new" onClick={() => void newNote()} title="New note">＋</button>
        <h2>Library</h2>
        <button className="tag" aria-selected={selectedTag === ALL}
                onClick={() => { setSelectedTag(ALL); setQuery(''); }}>
          <span>All Notes</span><span className="count">{vault.notes.size}</span>
        </button>
        <h2>Topics</h2>
        {topics.map((t) => (
          <button key={t.name} className="tag" title={t.description}
                  aria-selected={selectedTag === t.name}
                  onClick={() => { setSelectedTag(t.name); setQuery(''); }}>
            <span>{t.name}</span><span className="count">{counts.get(t.name) ?? 0}</span>
          </button>
        ))}
      </nav>

      <section className="pane list">
        <div className="list-header">
          <input className="search" placeholder="Search" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        {notes.map((n) => (
          <button key={n.id} className="item" aria-selected={selectedId === n.id}
                  onClick={() => setSelectedId(n.id)}>
            <span className="title">{n.title || 'New note'}</span>
            <span className="preview">{n.body.slice(0, 90) || 'No additional text'}</span>
            <span className="meta">
              {n.created ?? ''}{n.tags.length ? ` · ${n.tags.join(', ')}` : ''}
            </span>
          </button>
        ))}
        {!notes.length && <div className="empty" style={{ height: 120 }}>No notes</div>}
      </section>

      <main className="pane editor">
        {selected ? (
          <>
            <div className="editor-bar">
              {selected.source && <span>{selected.source}</span>}
              {selected.locator && <span className="chip">{selected.locator}</span>}
              {selected.tags.map((t) => <span key={t} className="chip">{t}</span>)}
              {!selected.enrichedAt && <span className="chip">awaiting enrichment</span>}
            </div>
            <textarea className="body" value={draft} spellCheck
                      onChange={(e) => onEdit(e.target.value)}
                      placeholder="Write what you want to remember…" />
          </>
        ) : (
          <div className="empty">Select a note</div>
        )}
      </main>

      {status && (
        <div className="status" data-state={status.conflict ? 'conflict' : 'ok'}>{status.message}</div>
      )}
    </div>
  );
}
