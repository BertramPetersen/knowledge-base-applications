import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  loadVault, buildIndex, search, notesByTag, resolveLink,
  parseNote, serializeNote, withBody, withNote,
  type Note, type Vault,
} from '@kb/core';
import { Markdown } from '@kb/core/react';
import { cachedVault, getMeta, setMeta } from './store.ts';
import { sync, lastSynced, markSeen, seenMap, type SyncResult } from './sync.ts';
import { checkAccess, type Repo } from './github.ts';
import { Setup } from './Setup.tsx';

type Tab = 'notes' | 'wikis' | 'revisit';

export default function App() {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const [tab, setTab] = useState<Tab>('notes');
  const [open, setOpen] = useState<{ kind: 'note'; id: string } | { kind: 'wiki'; tag: string } | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<Record<string, string>>({});
  const [online, setOnline] = useState(navigator.onLine);

  const source = useMemo(cachedVault, []);

  useEffect(() => {
    void getMeta<Repo>('repo').then((r) => r && setRepo(r));
    void seenMap().then(setSeen);
    void lastSynced().then((t) => t && setStatus(`synced ${new Date(t).toLocaleTimeString()}`));
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener('online', on); addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);

  const reload = useCallback(async () => setVault(await loadVault(source)), [source]);
  useEffect(() => { void reload(); }, [reload]);

  const runSync = useCallback(async (silent = false) => {
    if (!repo || busy) return;
    setBusy(true);
    if (!silent) setStatus('syncing…');
    try {
      const r: SyncResult = await sync(repo);
      await reload();
      setStatus(r.conflicts.length ? `conflict: ${r.conflicts[0].split('/').pop()}` : r.message);
    } catch (e) {
      setStatus(navigator.onLine ? `sync failed: ${e instanceof Error ? e.message : e}` : 'offline');
    } finally { setBusy(false); }
  }, [repo, busy, reload]);

  // On launch and on regaining signal. Not on a timer: a phone in a pocket
  // polling GitHub every few minutes spends battery to learn nothing.
  useEffect(() => { if (repo && online) void runSync(true); /* eslint-disable-next-line */ }, [repo, online]);

  const notes: Note[] = useMemo(() => {
    if (!vault) return [];
    if (query.trim()) return search(vault, buildIndex(vault), query, 40).map((h) => h.note);
    return [...vault.notes.values()].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  }, [vault, query]);

  /**
   * What to look at again. Oldest-seen first, and never-seen notes ahead of
   * those — a note read once and not since is exactly what this is for. The
   * ordering is deliberately dumb: a scheduler that needs grading is one more
   * thing to keep up with, and the point is to lower the cost of returning.
   */
  const revisit: Note[] = useMemo(() => {
    if (!vault) return [];
    return [...vault.notes.values()]
      .sort((a, b) => (seen[a.id] ?? '').localeCompare(seen[b.id] ?? ''))
      .slice(0, 12);
  }, [vault, seen]);

  const openNote = async (id: string) => {
    setOpen({ kind: 'note', id });
    setDraft(null);
    await markSeen(id);
    setSeen(await seenMap());
  };

  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const edit = (id: string, text: string) => {
    setDraft(text);
    setVault((v) => (v ? withBody(v, id, text) : v));
    writes.current = writes.current.then(async () => {
      const previous = await source.read(id);
      await source.write(id, serializeNote({ ...parseNote(id, previous), body: text }, previous));
    });
  };

  const capture = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const id = `raw/${today}-untitled-${Math.random().toString(36).slice(2, 10)}.md`;
    const raw = `---\ncreated: ${today}\n---\n\n`;
    await source.write(id, raw);
    setVault((v) => (v ? withNote(v, id, raw) : v));
    setOpen({ kind: 'note', id });
    setDraft('');
  };

  if (!repo) {
    return <Setup onDone={async (r) => {
      const check = await checkAccess(r);
      if (!check.ok) return check.reason;
      await setMeta('repo', r);
      setRepo(r);
      return null;
    }} />;
  }

  if (!vault) return <div className="empty">Opening vault…</div>;

  const note = open?.kind === 'note' ? vault.notes.get(open.id) ?? null : null;
  const wiki = open?.kind === 'wiki' ? vault.wikis.get(open.tag) ?? null : null;
  const resolve = (t: string) => resolveLink(vault, t);
  const body = draft ?? note?.body ?? '';

  if (note || wiki) {
    return (
      <div className="screen">
        <header className="bar">
          <button className="back" onClick={() => { setOpen(null); setDraft(null); void runSync(true); }}>‹ Back</button>
          {note && (
            <button className="act" onClick={() => setDraft(draft === null ? note.body : null)}>
              {draft === null ? 'Edit' : 'Done'}
            </button>
          )}
        </header>
        <main className="reader">
          {wiki ? (
            <>
              <div className="chips"><span className="chip">{wiki.sourceCount ?? 0} sources</span><span className="chip">generated</span></div>
              <Markdown source={wiki.overview} onOpen={(id) => void openNote(id)} resolve={resolve} />
            </>
          ) : draft !== null ? (
            <textarea className="editor" value={body} autoFocus
                      onChange={(e) => edit(note!.id, e.target.value)}
                      placeholder="Write what you want to remember…" />
          ) : (
            <>
              <div className="chips">
                {note!.source && <span className="chip">{note!.source}</span>}
                {note!.tags.map((t) => <span key={t} className="chip">{t}</span>)}
                {!note!.enrichedAt && <span className="chip">awaiting enrichment</span>}
              </div>
              <Markdown source={body} onOpen={(id) => void openNote(id)} resolve={resolve} />
              {(vault.backlinks.get(note!.id) ?? []).length > 0 && (
                <section className="backlinks">
                  <h3>Linked from</h3>
                  {(vault.backlinks.get(note!.id) ?? []).map((id) => (
                    <button key={id} onClick={() => void openNote(id)}>{vault.notes.get(id)?.title ?? id}</button>
                  ))}
                </section>
              )}
            </>
          )}
        </main>
      </div>
    );
  }

  const wikis = [...vault.wikis.values()].sort((a, b) => a.tag.localeCompare(b.tag));

  return (
    <div className="screen">
      <header className="bar">
        <h1>{tab === 'notes' ? 'Notes' : tab === 'wikis' ? 'Wikis' : 'Revisit'}</h1>
        <button className="act" onClick={() => void runSync()} disabled={busy}>{busy ? '…' : '↻'}</button>
      </header>

      {tab === 'notes' && (
        <div className="search-wrap">
          <input className="search" placeholder="Search" value={query} inputMode="search"
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}

      <main className="list">
        {tab === 'notes' && notes.map((n) => (
          <button key={n.id} className="row" onClick={() => void openNote(n.id)}>
            <span className="row-title">{n.title || 'New note'}</span>
            <span className="row-preview">{n.preview || 'No additional text'}</span>
            <span className="row-meta">{n.created ?? ''}{n.tags.length ? ` · ${n.tags.join(', ')}` : ''}</span>
          </button>
        ))}
        {tab === 'wikis' && wikis.map((w) => (
          <button key={w.tag} className="row" onClick={() => setOpen({ kind: 'wiki', tag: w.tag })}>
            <span className="row-title">{w.tag}</span>
            <span className="row-meta">{w.sourceCount ?? 0} sources
              {w.refreshedAt ? ` · refreshed ${w.refreshedAt.slice(0, 10)}` : ''}</span>
          </button>
        ))}
        {tab === 'revisit' && revisit.map((n) => (
          <button key={n.id} className="row" onClick={() => void openNote(n.id)}>
            <span className="row-title">{n.title || 'New note'}</span>
            <span className="row-preview">{n.preview}</span>
            <span className="row-meta">{seen[n.id] ? `last seen ${seen[n.id].slice(0, 10)}` : 'never opened'}</span>
          </button>
        ))}
        {!notes.length && tab === 'notes' && <div className="empty">No notes</div>}
        {!wikis.length && tab === 'wikis' && <div className="empty">No wikis yet — a tag needs three notes</div>}
      </main>

      <button className="fab" onClick={() => void capture()} aria-label="New note">＋</button>

      <nav className="tabs">
        {(['notes', 'wikis', 'revisit'] as Tab[]).map((t) => (
          <button key={t} aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'notes' ? 'Notes' : t === 'wikis' ? 'Wikis' : 'Revisit'}
          </button>
        ))}
      </nav>

      <div className="status" data-offline={!online}>{online ? status : 'offline — changes are saved locally'}</div>
    </div>
  );
}
