// Verify core against the real vault. No UI, no Tauri — if this is wrong the
// app is wrong, so it is worth proving before any of that exists.
import { fsSource } from './node/fsSource.ts';
import { loadVault, notesByTag, tagCounts, brokenLinks, pending,
         resolveLink, notesInFolder, folderTree } from './src/vault.ts';
import type { Folder } from './src/types.ts';
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


// ── folders and link resolution ─────────────────────────────────────────────
// A note must stay reachable after it moves, or the folder tree is a trap.
const printTree = (f: Folder, depth = 0) => {
  if (depth) console.log(`  ${'  '.repeat(depth)}${f.name}/  ${f.count}`);
  f.children.forEach((c) => printTree(c, depth + 1));
};
console.log('\n  folders:');
printTree(vault.folders);
console.log(`  root, non-recursive: ${notesInFolder(vault, '', false).length}` +
  `   raw/, recursive: ${notesInFolder(vault, 'raw').length}`);

const sample = [...vault.notes.keys()][0];
const base = sample.slice(sample.lastIndexOf('/') + 1).replace(/\.md$/, '');
console.log(`\n  resolving "${sample}":`);
for (const form of [sample, sample.replace(/\.md$/, ''), `${base}.md`, base])
  console.log(`     ${form.padEnd(56)} -> ${resolveLink(vault, form) ?? 'UNRESOLVED'}`);

// The point of the exercise: simulate the move and re-resolve every link.
const moved = new Map(vault.notes);
moved.delete(sample);
moved.set(`Work/Trading/${base}.md`, { ...vault.notes.get(sample)!, id: `Work/Trading/${base}.md` });
const after = { ...vault, notes: moved, links: (await import('./src/vault.ts')).linkIndex(moved),
                folders: folderTree(moved) };
const survived = [...vault.notes.values()].flatMap((n) => n.links)
  .filter((l) => resolveLink(vault, l.to)).length;
const stillSurvive = [...moved.values()].flatMap((n) => n.links)
  .filter((l) => resolveLink(after as any, l.to)).length;
console.log(`\n  links resolving now: ${survived}   after moving one note to Work/Trading/: ${stillSurvive}`);
