// Verify core against the real vault. No UI, no Tauri — if this is wrong the
// app is wrong, so it is worth proving before any of that exists.
import { fsSource } from './src/fsSource.ts';
import { loadVault, notesByTag, tagCounts, brokenLinks, pending } from './src/vault.ts';
import { buildIndex, search } from './src/search.ts';
import { parseNote, serializeNote } from './src/frontmatter.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const VAULT = process.argv[2] ?? join(process.env.HOME!, 'Documents/KnowledgeBase');
const src = fsSource(VAULT);
const vault = await loadVault(src);

console.log(`  notes ${vault.notes.size}  tags ${vault.tags.size}  wikis ${vault.wikis.size}` +
  `  backlinked ${vault.backlinks.size}`);

const counts = [...tagCounts(vault)].sort((a, b) => b[1] - a[1]);
console.log('  top tags: ' + counts.slice(0, 5).map(([t, n]) => `${t}(${n})`).join(' '));

console.log(`  broken links: ${brokenLinks(vault).length}   un-enriched: ${pending(vault).length}`);

const idx = buildIndex(vault);
for (const q of ['forecasting', 'risk exposure', 'parser']) {
  const hits = search(vault, idx, q, 2);
  console.log(`\n  "${q}" -> ${hits.length} hits`);
  for (const h of hits) console.log(`     ${h.score.toFixed(2)}  ${h.note.title.slice(0, 62)}`);
}

console.log(`\n  notesByTag('uncertainty'): ${notesByTag(vault, 'uncertainty').length}`);

// Round-trip is the property that matters most: the app and the enrichment job
// write the same files, so serialising must not reorder or reformat anything.
let identical = 0, differing: string[] = [];
for (const id of vault.notes.keys()) {
  const original = await readFile(join(VAULT, id), 'utf8');
  const out = serializeNote(parseNote(id, original), original);
  out === original ? identical++ : differing.push(id);
}
console.log(`\n  round-trip byte-identical:      ${identical}/${vault.notes.size}`);

// The two outliers are hand-written files with irregular trailing whitespace.
// The pipeline normalises to one trailing newline, so they converge after a
// single write — but the content must match exactly even now.
let sameIgnoringEol = 0;
for (const id of vault.notes.keys()) {
  const original = await readFile(join(VAULT, id), 'utf8');
  const out = serializeNote(parseNote(id, original), original);
  if (out.trimEnd() === original.trimEnd()) sameIgnoringEol++;
}
console.log(`  identical ignoring trailing EOL: ${sameIgnoringEol}/${vault.notes.size}`);
for (const d of differing.slice(0, 3)) console.log(`     differs: ${d}`);
