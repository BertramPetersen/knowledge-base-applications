import type { Note, NoteId, Tag, Vault, VaultSource, Wiki } from './types.ts';
import { parseNote } from './frontmatter.ts';

const isNote = (p: string) => p.startsWith('raw/') && p.endsWith('.md');

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
  await Promise.all(paths.filter((p) => p.startsWith('wikis/') && p.endsWith('overview.md'))
    .map(async (p) => {
      const raw = await source.read(p);
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const get = (k: string) => fm?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim();
      const tag = get('tag') ?? p.split('/')[1];
      wikis.set(tag, {
        tag, overview: (fm ? fm[2] : raw).trim(),
        sourceCount: Number(get('sourceCount')) || undefined,
        refreshedAt: get('refreshedAt'),
      });
    }));

  // Backlinks are the half of the graph the notes do not store. A note knows
  // what it points at; knowing what points *back* is what makes "where did this
  // come up before" answerable.
  const backlinks = new Map<NoteId, NoteId[]>();
  for (const note of notes.values())
    for (const l of note.links)
      if (notes.has(l.to)) backlinks.set(l.to, [...(backlinks.get(l.to) ?? []), note.id]);

  return { notes, tags, wikis, backlinks };
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
    n.links.filter((l) => !v.notes.has(l.to)).map((l) => ({ from: n.id, to: l.to })));
