import type { Folder, Note, NoteId, Tag, Vault, VaultSource, Wiki } from './types.ts';
import { parseNote, deriveTitle, derivePreview, extractLinks } from './frontmatter.ts';

/**
 * `wikis/` is generated and `tags.md` is the vocabulary; both are machine-owned.
 * Everything else that is markdown is a note, wherever the user filed it.
 *
 * `raw/` used to be the only place a note could live. It is now just the folder
 * the pipeline drops captures into — one folder among however many the user
 * makes. Keeping the reserved set small is deliberate: a folder tree the user
 * controls is only useful if the app does not quietly claim names in it.
 */
const RESERVED = new Set(['tags.md', 'README.md', 'AGENTS.md', 'CLAUDE.md']);
/**
 * Dotted directories are tooling, not content: `.agents/` holds the skill files,
 * `.obsidian/` the editor's config. The desktop never saw them because the Rust
 * walker skips dot-entries, so this lived on one platform only — and the mobile
 * client, reading the same vault through a git tree, listed four skill documents
 * as notes. The rule belongs to the vault, not to whichever way it was read.
 */
const isNote = (p: string) =>
  p.endsWith('.md') && !p.startsWith('wikis/') && !RESERVED.has(p)
  && !p.split('/').some((seg) => seg.startsWith('.'));

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');

/**
 * Link targets are resolved, not matched. A note's identity is still its path,
 * but a link may name it three ways — `raw/kelly.md`, `kelly.md`, `kelly` — and
 * all three must land on the same note.
 *
 * This is what lets a note move between folders without breaking its inbound
 * links, which is the whole reason folders can exist at all. Exact path wins;
 * a basename only resolves when it is unambiguous across the vault, because
 * silently picking one of two `meeting.md` files is worse than a broken link.
 */
export function linkIndex(notes: Map<NoteId, Note>): Map<string, NoteId | null> {
  const index = new Map<string, NoteId | null>();
  const add = (key: string, id: NoteId) => {
    if (index.has(key) && index.get(key) !== id) index.set(key, null);
    else index.set(key, id);
  };
  for (const id of notes.keys()) {
    add(basename(id), id);
    add(`${basename(id)}.md`, id);
    add(id.replace(/\.md$/, ''), id);
  }
  // A real path is never ambiguous, so it is written last and always wins — a
  // root-level `foo.md` must not be shadowed by some other folder's `foo.md`.
  for (const id of notes.keys()) index.set(id, id);
  return index;
}

/**
 * Every link in the vault today is written as a full path, because that is what
 * the enricher emits. So the path is tried first and the bare name last: an
 * existing `[[raw/kelly.md]]` keeps working, and keeps working after the note is
 * moved out of `raw/`, without rewriting a single file.
 */
export const resolveLink = (v: Vault, target: string): NoteId | null =>
  v.links.get(target)
  ?? v.links.get(target.replace(/\.md$/, ''))
  ?? v.links.get(basename(target))
  ?? null;

/** How a link should read when the author gave no alias: the name, not the path. */
export const linkLabel = (target: string) => basename(target);

/** The folder tree, derived from note ids. Nothing stores it; it is the paths. */
export function folderTree(notes: Map<NoteId, Note>): Folder {
  const root: Folder = { name: '', path: '', children: [], count: 0 };
  for (const id of notes.keys()) {
    const parts = id.split('/').slice(0, -1);
    let node = root;
    node.count++;
    for (const part of parts) {
      let next = node.children.find((c) => c.name === part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, children: [], count: 0 };
        node.children.push(next);
      }
      next.count++;
      node = next;
    }
  }
  const sort = (f: Folder) => { f.children.sort((a, b) => a.name.localeCompare(b.name)); f.children.forEach(sort); };
  sort(root);
  return root;
}

/** tags.md is the controlled vocabulary — the routing table retrieval depends on. */
export function parseTags(text: string): Map<string, Tag> {
  const out = new Map<string, Tag>();
  let kind: Tag['kind'] = 'topic';
  for (const line of text.split('\n')) {
    if (/^##\s+Source medium/i.test(line)) kind = 'medium';
    else if (/^##\s/.test(line)) kind = 'topic';
    const m = line.match(/^\s*[-*]\s+`([a-z0-9/-]+)`\s*(?:—\s*(.*))?$/);
    if (m) out.set(m[1], { name: m[1], description: m[2]?.trim(), kind });
  }
  return out;
}

export async function loadVault(source: VaultSource): Promise<Vault> {
  const paths = await source.list();
  const notes = new Map<NoteId, Note>();

  await Promise.all(paths.filter(isNote).map(async (p) => {
    notes.set(p, parseNote(p, await source.read(p)));
  }));

  const tags = paths.includes('tags.md')
    ? parseTags(await source.read('tags.md')) : new Map<string, Tag>();

  const wikis = new Map<string, Wiki>();
  const wikiPaths = new Set(paths);
  await Promise.all(paths.filter((p) => p.startsWith('wikis/') && p.endsWith('overview.md'))
    .map(async (p) => {
      const raw = await source.read(p);
      const logPath = p.replace(/overview\.md$/, 'log.md');
      const log = wikiPaths.has(logPath) ? await source.read(logPath).catch(() => '') : '';
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const get = (k: string) => fm?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim();
      const tag = get('tag') ?? p.split('/')[1];
      wikis.set(tag, {
        tag, overview: (fm ? fm[2] : raw).trim(),
        sourceCount: Number(get('sourceCount')) || undefined,
        refreshedAt: get('refreshedAt'),
        lastChange: lastLogEntry(log),
      });
    }));

  // Backlinks are the half of the graph the notes do not store. A note knows
  // what it points at; knowing what points *back* is what makes "where did this
  // come up before" answerable.
  return derive(notes, tags, wikis);
}

/**
 * Everything in a Vault other than the notes is derived from them, so changing
 * a note means rebuilding those three structures. It is O(n) over a corpus that
 * is already in memory — cheap enough to do on a keystroke, which is what lets
 * an edit show up everywhere at once instead of at the next reload.
 */
function derive(notes: Map<NoteId, Note>, tags: Map<string, Tag>, wikis: Map<string, Wiki>): Vault {
  const links = linkIndex(notes);
  const backlinks = new Map<NoteId, NoteId[]>();
  for (const note of notes.values())
    for (const l of note.links) {
      const to = links.get(l.to) ?? links.get(l.to.replace(/\.md$/, '')) ?? links.get(l.to.slice(l.to.lastIndexOf('/') + 1).replace(/\.md$/, ''));
      if (to) backlinks.set(to, [...(backlinks.get(to) ?? []), note.id]);
    }
  return { notes, tags, wikis, backlinks, links, folders: folderTree(notes) };
}

/** The vault with one note's prose replaced — the editor's optimistic update. */
export function withBody(v: Vault, id: NoteId, body: string): Vault {
  const prev = v.notes.get(id);
  if (!prev || prev.body === body) return v;
  const notes = new Map(v.notes);
  notes.set(id, {
    ...prev, body,
    title: deriveTitle(body), preview: derivePreview(body), links: extractLinks(body),
  });
  return derive(notes, v.tags, v.wikis);
}

/** The vault with a note added or replaced from its file text. */
export function withNote(v: Vault, id: NoteId, raw: string): Vault {
  const notes = new Map(v.notes);
  notes.set(id, parseNote(id, raw));
  return derive(notes, v.tags, v.wikis);
}

export function withoutNote(v: Vault, id: NoteId): Vault {
  if (!v.notes.has(id)) return v;
  const notes = new Map(v.notes);
  notes.delete(id);
  return derive(notes, v.tags, v.wikis);
}

/** Notes filed directly in `path` (`''` is the vault root), or anywhere beneath it. */
export const notesInFolder = (v: Vault, path: string, deep = true): Note[] =>
  [...v.notes.values()].filter((n) => {
    const dir = n.id.slice(0, Math.max(0, n.id.lastIndexOf('/')));
    return deep ? dir === path || dir.startsWith(path ? `${path}/` : '') : dir === path;
  }).sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));

/**
 * Moving a note rewrites no links — they resolve by name — but it does change
 * the note's identity, so it is a write-then-delete rather than an edit.
 */
export async function moveNote(source: VaultSource, from: NoteId, to: NoteId): Promise<void> {
  if (from === to) return;
  const content = await source.read(from);
  await source.write(to, content);
  await source.remove?.(from);
}

/** log.md is append-only, newest last, each entry a `## …` heading plus prose. */
function lastLogEntry(log: string): { heading: string; body: string } | undefined {
  const at = log.lastIndexOf('\n## ');
  const start = at === -1 ? (log.startsWith('## ') ? 0 : -1) : at + 1;
  if (start === -1) return undefined;
  const [heading, ...rest] = log.slice(start).split('\n');
  const body = rest.join('\n').trim();
  return { heading: heading.replace(/^##\s*/, '').trim(), body };
}

export const notesByTag = (v: Vault, tag: string): Note[] =>
  [...v.notes.values()].filter((n) => n.tags.includes(tag))
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));

export const tagCounts = (v: Vault): Map<string, number> => {
  const c = new Map<string, number>();
  for (const n of v.notes.values()) for (const t of n.tags) c.set(t, (c.get(t) ?? 0) + 1);
  return c;
};

/** Notes with no `enrichedAt` — the pipeline has not processed them yet. */
export const pending = (v: Vault): Note[] =>
  [...v.notes.values()].filter((n) => !n.enrichedAt);

/** A link whose target does not exist. Should always be empty; worth surfacing. */
export const brokenLinks = (v: Vault): { from: NoteId; to: NoteId }[] =>
  [...v.notes.values()].flatMap((n) =>
    n.links.filter((l) => !resolveLink(v, l.to)).map((l) => ({ from: n.id, to: l.to })));
