import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  loadVault, buildIndex, search, tagCounts, notesByTag, notesInFolder,
  parseNote, serializeNote, moveNote, resolveLink, VaultGit, autoSync,
  type Folder, type Note, type Vault, type SyncResult,
} from '@kb/core';
import { tauriVault, tauriGit } from './tauriVault.ts';
import { Markdown } from './Markdown.tsx';
import { FolderTree } from './FolderTree.tsx';

/**
 * What the note list is currently showing. Folders are the user's organisation
 * and tags are the machine's; they answer different questions ("where did I put
 * it" versus "what else touches this"), so they are peers here rather than one
 * being built out of the other.
 */
type Scope =
  | { kind: 'all' }
  | { kind: 'tag'; name: string }
  | { kind: 'folder'; path: string };

type Selection = { kind: 'note'; id: string } | { kind: 'wiki'; tag: string } | null;

const dirOf = (id: string) => id.slice(0, Math.max(0, id.lastIndexOf('/')));
const nameOf = (id: string) => id.slice(id.lastIndexOf('/') + 1);

const flatten = (f: Folder, out: string[] = []): string[] => {
  for (const c of f.children) { out.push(c.path); flatten(c, out); }
  return out;
};

export default function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(() => localStorage.getItem('vault'));
  const [vault, setVault] = useState<Vault | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [sel, setSel] = useState<Selection>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Folders live in the note paths, so one with nothing in it has nowhere to be
  // stored. Holding it here lets the user make a folder, then a note, in that
  // order — it becomes real on the first write.
  const [pendingFolders, setPendingFolders] = useState<string[]>([]);
  const [newFolder, setNewFolder] = useState<string | null>(null);

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

  // 60s, not 10: every pause while writing becomes a commit, and this history is
  // also the audit trail for what the enrichment job did.
  const syncer = useMemo(() => (git ? autoSync(git, 60_000, setStatus) : null), [git]);
  useEffect(() => () => syncer?.stop(), [syncer]);

  const index = useMemo(() => (vault ? buildIndex(vault) : null), [vault]);
  const counts = useMemo(() => (vault ? tagCounts(vault) : new Map<string, number>()), [vault]);

  const notes: Note[] = useMemo(() => {
    if (!vault) return [];
    if (query.trim() && index) return search(vault, index, query, 50).map((h) => h.note);
    if (sel?.kind === 'wiki') return notesByTag(vault, sel.tag);
    if (scope.kind === 'folder') return notesInFolder(vault, scope.path);
    const list = scope.kind === 'tag' ? notesByTag(vault, scope.name) : [...vault.notes.values()];
    return [...list].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  }, [vault, index, query, scope, sel]);

  const selected = sel?.kind === 'note' ? vault?.notes.get(sel.id) ?? null : null;
  const wiki = sel?.kind === 'wiki' ? vault?.wikis.get(sel.tag) ?? null : null;

  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (selected && loadedId.current !== selected.id) {
      loadedId.current = selected.id;
      setDraft(selected.body);
      setEditing(!selected.body.trim());   // a blank note opens ready to write
    } else if (!selected) loadedId.current = null;
  }, [selected]);

  const openNote = (id: string) => { setSel({ kind: 'note', id }); setEditing(false); };
  const browse = (s: Scope) => { setScope(s); setQuery(''); if (sel?.kind === 'wiki') setSel(null); };

  const onEdit = (text: string) => {
    setDraft(text);
    if (!selected || !source) return;
    void (async () => {
      const previous = await source.read(selected.id);
      const note = parseNote(selected.id, previous);
      await source.write(selected.id, serializeNote({ ...note, body: text }, previous));
      syncer?.touch();
    })().catch((e) => setError(String(e)));
  };

  const newNote = async () => {
    if (!source) return;
    const today = new Date().toISOString().slice(0, 10);
    // `raw/` is the default drawer rather than a requirement: it is where the
    // capture sync lands notes, so an unfiled note keeps company with the rest.
    const dir = scope.kind === 'folder' ? scope.path : 'raw';
    const id = `${dir ? `${dir}/` : ''}${today}-untitled-${Math.random().toString(36).slice(2, 10)}.md`;
    await source.write(id, `---\ncreated: ${today}\n---\n\n`);
    setPendingFolders((p) => p.filter((f) => f !== dir));
    await reload();
    setSel({ kind: 'note', id });
    setDraft(''); setEditing(true); loadedId.current = id;
    syncer?.touch();
  };

  const moveTo = async (dir: string) => {
    if (!source || !selected || dir === dirOf(selected.id)) return;
    const to = `${dir ? `${dir}/` : ''}${nameOf(selected.id)}`;
    try {
      await moveNote(source, selected.id, to);
      loadedId.current = to;              // same content; do not reload the draft
      setPendingFolders((p) => p.filter((f) => f !== dir));
      await reload();
      setSel({ kind: 'note', id: to });
      syncer?.touch();
    } catch (e) { setError(String(e)); }
  };

  const createFolder = (name: string) => {
    const parent = scope.kind === 'folder' ? scope.path : '';
    const path = `${parent ? `${parent}/` : ''}${name.trim().replace(/^\/+|\/+$/g, '')}`;
    setNewFolder(null);
    if (!name.trim()) return;
    setPendingFolders((p) => (p.includes(path) ? p : [...p, path]));
    browse({ kind: 'folder', path });
  };

  if (!vault) return <div className="empty">{error ?? 'Opening vault…'}</div>;

  const topics = [...vault.tags.values()].filter((t) => t.kind === 'topic');
  const wikis = [...vault.wikis.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  const backlinks = selected ? vault.backlinks.get(selected.id) ?? [] : [];
  const allFolders = [...new Set([...flatten(vault.folders), ...pendingFolders])].sort();
  const resolve = (target: string) => resolveLink(vault, target);

  return (
    <div className="app">
      {/* The window has no title bar (hiddenTitle + Overlay), so it needs an
          explicit surface to drag by. Without it, dragging selects text. */}
      <div className="titlebar" data-tauri-drag-region />
      <nav className="pane sidebar">
        <button className="new" onClick={() => void newNote()} title="New note">＋</button>
        <h2>Library</h2>
        <button className="tag" aria-selected={scope.kind === 'all' && sel?.kind !== 'wiki'}
                onClick={() => browse({ kind: 'all' })}>
          <span>All Notes</span><span className="count">{vault.notes.size}</span>
        </button>

        <h2>
          Folders
          <button className="add" title="New folder" onClick={() => setNewFolder('')}>＋</button>
        </h2>
        <FolderTree root={vault.folders} pending={pendingFolders}
                    selected={scope.kind === 'folder' && sel?.kind !== 'wiki' ? scope.path : null}
                    onSelect={(path) => browse({ kind: 'folder', path })} />
        {newFolder !== null && (
          <input className="search folder-input" autoFocus placeholder="Folder name"
                 value={newFolder} onChange={(e) => setNewFolder(e.target.value)}
                 onBlur={() => createFolder(newFolder)}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') createFolder(newFolder);
                   if (e.key === 'Escape') setNewFolder(null);
                 }} />
        )}

        {wikis.length > 0 && <h2>Wikis</h2>}
        {wikis.map((w) => (
          <button key={w.tag} className="tag" aria-selected={sel?.kind === 'wiki' && sel.tag === w.tag}
                  onClick={() => { setSel({ kind: 'wiki', tag: w.tag }); setQuery(''); }}>
            <span>{w.tag}</span><span className="count">{w.sourceCount ?? counts.get(w.tag) ?? 0}</span>
          </button>
        ))}

        <h2>Topics</h2>
        {topics.map((t) => (
          <button key={t.name} className="tag" title={t.description}
                  aria-selected={sel?.kind !== 'wiki' && scope.kind === 'tag' && scope.name === t.name}
                  onClick={() => browse({ kind: 'tag', name: t.name })}>
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
          <button key={n.id} className="item" aria-selected={selected?.id === n.id}
                  onClick={() => openNote(n.id)}>
            <span className="title">{n.title || 'New note'}</span>
            <span className="preview">{n.body.slice(0, 90) || 'No additional text'}</span>
            <span className="meta">{n.created ?? ''}{n.tags.length ? ` · ${n.tags.join(', ')}` : ''}</span>
          </button>
        ))}
        {!notes.length && <div className="empty" style={{ height: 120 }}>No notes</div>}
      </section>

      <main className="pane editor">
        {wiki ? (
          <>
            <div className="editor-bar">
              <span className="wiki-title">{wiki.tag}</span>
              <span className="chip">{wiki.sourceCount ?? 0} sources</span>
              {wiki.refreshedAt && <span className="chip">refreshed {wiki.refreshedAt.slice(0, 10)}</span>}
              <span className="grow" />
              <span className="chip" title="Wikis are generated from your notes; edit the notes instead">
                generated
              </span>
            </div>
            <div className="scroll">
              <Markdown source={wiki.overview} onOpen={openNote} resolve={resolve} />
            </div>
          </>
        ) : selected ? (
          <>
            <div className="editor-bar">
              <select className="move" value={dirOf(selected.id)}
                      title="Move to folder"
                      onChange={(e) => void moveTo(e.target.value)}>
                <option value="">(vault root)</option>
                {allFolders.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              {selected.source && <span>{selected.source}</span>}
              {selected.locator && <span className="chip">{selected.locator}</span>}
              {selected.tags.map((t) => <span key={t} className="chip">{t}</span>)}
              {!selected.enrichedAt && <span className="chip">awaiting enrichment</span>}
              <span className="grow" />
              <button className="toggle" onClick={() => setEditing((e) => !e)}>
                {editing ? 'Done' : 'Edit'}
              </button>
            </div>
            {editing ? (
              <textarea className="body" value={draft} spellCheck autoFocus
                        onChange={(e) => onEdit(e.target.value)}
                        placeholder="Write what you want to remember…" />
            ) : (
              <div className="scroll" onDoubleClick={() => setEditing(true)}>
                <Markdown source={draft} onOpen={openNote} resolve={resolve} />
                {backlinks.length > 0 && (
                  <section className="backlinks">
                    <h3>Linked from</h3>
                    {backlinks.map((id) => (
                      <button key={id} className="backlink" onClick={() => openNote(id)}>
                        {vault.notes.get(id)?.title ?? id}
                      </button>
                    ))}
                  </section>
                )}
              </div>
            )}
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
