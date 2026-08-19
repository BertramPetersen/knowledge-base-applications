import type { Note, Vault } from './types.ts';

/** Crude suffix stripping. Not linguistics — just enough that "forecast" finds
 *  "forecasting", which is the difference between search working and not. */
function stem(w: string): string {
  for (const s of ['ingly', 'edly', 'ing', 'edly', 'ies', 'ied', 'ed', 'es', 'ly', 's'])
    if (w.length > s.length + 3 && w.endsWith(s)) return w.slice(0, -s.length);
  return w;
}

const tokenize = (t: string): string[] =>
  t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/).filter((w) => w.length > 1).map(stem);

export interface SearchIndex {
  /** term -> note id -> term frequency */
  postings: Map<string, Map<string, number>>;
  lengths: Map<string, number>;
  count: number;
}

export function buildIndex(vault: Vault): SearchIndex {
  const postings = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  for (const note of vault.notes.values()) {
    // Tags and source are worth matching on, so they join the searchable text.
    const terms = tokenize(`${note.body} ${note.tags.join(' ')} ${note.source ?? ''}`);
    lengths.set(note.id, terms.length || 1);
    for (const t of terms) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = new Map()));
      p.set(note.id, (p.get(note.id) ?? 0) + 1);
    }
  }
  return { postings, lengths, count: vault.notes.size };
}

export interface Hit { note: Note; score: number; snippet: string }

/** BM25. Cheap to compute, and much better than substring matching at ranking
 *  a short note that is *about* the term above a long one that mentions it. */
export function search(vault: Vault, index: SearchIndex, query: string, limit = 20): Hit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const k1 = 1.2, b = 0.75;
  const avg = [...index.lengths.values()].reduce((a, n) => a + n, 0) / (index.count || 1);
  const scores = new Map<string, number>();

  for (const term of terms) {
    const p = index.postings.get(term);
    if (!p) continue;
    const idf = Math.log(1 + (index.count - p.size + 0.5) / (p.size + 0.5));
    for (const [id, tf] of p) {
      const len = index.lengths.get(id) ?? 1;
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / avg));
      scores.set(id, (scores.get(id) ?? 0) + idf * norm);
    }
  }

  return [...scores.entries()]
    .sort((a, b2) => b2[1] - a[1]).slice(0, limit)
    .map(([id, score]) => {
      const note = vault.notes.get(id)!;
      return { note, score, snippet: snippetFor(note.body, terms) };
    });
}

function snippetFor(body: string, terms: string[], width = 160): string {
  const words = body.split(/\s+/);
  const hit = words.findIndex((w) => terms.includes(stem(w.toLowerCase().replace(/\W/g, ''))));
  if (hit < 0) return body.slice(0, width).trim() + (body.length > width ? '…' : '');
  const start = Math.max(0, hit - 12);
  const text = words.slice(start, start + 32).join(' ');
  return (start > 0 ? '…' : '') + text + (start + 32 < words.length ? '…' : '');
}
