import type { Note, NoteId } from './types.ts';

const KNOWN = ['created', 'tags', 'enrichedAt', 'source', 'url', 'locator',
  'captureId', 'captureImage'] as const;

export const extractLinks = (text: string) =>
  [...text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)].map((l) => ({ to: l[1], alias: l[2] }));

/**
 * Markdown as a reader sees it. Titles and list previews are chrome, not prose:
 * showing `# Lessons from building…` there leaks the syntax into a place that
 * has no way to render it, so the marker is stripped rather than displayed.
 */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
      (_, t: string, a: string) => a || t.slice(t.lastIndexOf('/') + 1).replace(/\.md$/, ''))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1');
}

const clip = (s: string, limit: number) =>
  s.length <= limit ? s : s.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';

/**
 * The note's first line of its own prose. A leading `>` is a quotation from the
 * source, not the owner's words, so it is not the note's title — which means the
 * marker has to be looked for before plainText strips it away.
 */
const titleLine = (body: string) =>
  body.split('\n').findIndex((l) => l.trim() && !l.trimStart().startsWith('>'));

/** First non-empty, non-quote line, as a reader would see it. Display only. */
export function deriveTitle(body: string, limit = 80): string {
  const i = titleLine(body);
  return clip(i < 0 ? '' : plainText(body.split('\n')[i]).trim(), limit);
}

/**
 * What the list row shows under the title: the note minus its title line —
 * everything else, not everything after. A note that opens with a quotation
 * takes its title from below it, and the quotation is still content.
 */
export function derivePreview(body: string, limit = 120): string {
  const i = titleLine(body);
  const rest = body.split('\n').filter((_, n) => n !== i).join('\n');
  return clip(plainText(rest).replace(/\s+/g, ' ').trim(), limit);
}

export function parseNote(id: NoteId, raw: string): Note {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fmText = m ? m[1] : '';
  const rest = (m ? m[2] : raw).trim();

  const fm: Record<string, string> = {};
  for (const line of fmText.split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }

  const body = rest.replace(/\n##\s+Related\n[\s\S]*$/, '').trim();
  const links = extractLinks(rest);

  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) if (!KNOWN.includes(k as any)) extra[k] = v;

  return {
    id, body, title: deriveTitle(body), preview: derivePreview(body),
    tags: fm.tags ? fm.tags.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean) : [],
    created: fm.created, enrichedAt: fm.enrichedAt, source: fm.source, url: fm.url,
    locator: fm.locator, captureId: fm.captureId, captureImage: fm.captureImage,
    links, extra,
  };
}

/**
 * A plain YAML scalar only breaks on a colon *followed by a space*, a hash
 * *preceded* by one, surrounding whitespace, or a leading indicator character.
 * A bare `2026-08-18T15:29:04Z` is valid — quoting on any colon at all would
 * rewrite every timestamp in the vault for no reason.
 */
const needsQuotes = (v: string) =>
  v === '' || /^\s|\s$/.test(v) || /:\s/.test(v) || /\s#/.test(v) ||
  /^[-?:,[\]{}#&*!|>'"%@`]/.test(v);

/**
 * Write a note back.
 *
 * `previous` is the file's current text, and passing it is almost always right:
 * it preserves the existing frontmatter key order. The enrichment job inserts
 * keys wherever it likes, and rebuilding in a canonical order instead would
 * rewrite every note the app touches — producing diffs that say nothing and
 * fighting the job for the same lines. Learned the hard way.
 */
export function serializeNote(note: Note, previous?: string): string {
  const values: Record<string, string | undefined> = {
    created: note.created,
    tags: note.tags.length ? `[${note.tags.join(', ')}]` : undefined,
    enrichedAt: note.enrichedAt, source: note.source, url: note.url,
    locator: note.locator, captureId: note.captureId, captureImage: note.captureImage,
    ...note.extra,
  };

  // Preserve the file's own key order *and* its quoting. Guessing at quoting
  // rewrites lines nobody changed: `enrichedAt` holds colons but is written
  // bare, while `source` is always quoted even when it needs no escaping. A
  // heuristic gets both backwards; the file already knows the answer.
  const order: string[] = [];
  const wasQuoted = new Set<string>();
  const prevFm = previous?.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (prevFm) {
    for (const line of prevFm.split('\n')) {
      const i = line.indexOf(':');
      if (i < 1) continue;
      const k = line.slice(0, i).trim();
      order.push(k);
      if (/^\s*["']/.test(line.slice(i + 1))) wasQuoted.add(k);
    }
  }
  for (const k of Object.keys(values)) if (!order.includes(k)) order.push(k);

  const lines = order
    .filter((k) => values[k] !== undefined && values[k] !== '')
    .map((k) => {
      if (k === 'tags') return `tags: ${values[k]}`;
      const v = values[k]!;
      // Quote if the file did, or if the new value cannot go bare.
      return wasQuoted.has(k) || needsQuotes(v)
        ? `${k}: "${v.replace(/"/g, "'")}"` : `${k}: ${v}`;
    });

  const related = note.links.length
    ? '\n\n## Related\n\n' + note.links
        .map((l) => `- [[${l.to}${l.alias ? `|${l.alias}` : ''}]]`).join('\n')
    : '';

  return `---\n${lines.join('\n')}\n---\n\n${note.body.trim()}${related}\n`;
}
