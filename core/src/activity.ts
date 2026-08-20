import type { NoteId, Vault } from './types.ts';

/**
 * What the automation did while nobody was watching.
 *
 * There is no changelog to maintain, because the vault is a git repository and
 * the nightly job commits its own work — the history *is* the record. Writing a
 * separate activity file would be a second copy of something git already keeps
 * perfectly, and it would drift the first time a run half-failed.
 *
 * Both clients supply commits from wherever they can see them (system git on the
 * desktop, the REST API on the phone) and the interpretation happens here, once.
 */

export interface Commit {
  sha: string;
  /** Name or email — whatever the client can cheaply provide. */
  author: string;
  message: string;
  /** ISO 8601. */
  at: string;
  files: { path: string; status: 'A' | 'M' | 'D' }[];
}

/** The job commits under its own identity, which is what makes "the machine did
 *  this" answerable at all. A human's commits are not activity; they are memory. */
export const AGENT = 'kb-enrich';

export const byAgent = (c: Commit) => c.author.includes(AGENT) || c.message.startsWith(`${AGENT}:`);

export type Change =
  | { kind: 'note'; at: string; sha: string; id: NoteId; title: string; tags: string[]; added: boolean }
  | { kind: 'wiki'; at: string; sha: string; tag: string; heading?: string; body?: string };

const wikiTag = (path: string) => {
  const m = /^wikis\/([^/]+)\/overview\.md$/.exec(path);
  return m?.[1];
};

const isNotePath = (path: string) =>
  path.endsWith('.md') && !path.startsWith('wikis/')
  && !path.split('/').some((seg) => seg.startsWith('.'))
  && !['tags.md', 'README.md', 'AGENTS.md', 'CLAUDE.md'].includes(path);

/**
 * Commits become a list of things a person would want to be told.
 *
 * Deliberately not a file list. "3 files changed in wikis/uncertainty" says
 * nothing; "uncertainty gained two sources and the overview now contradicts
 * itself on purpose" is the thing worth reading, and the refresher already wrote
 * that sentence into log.md.
 *
 * Only overview.md counts as a wiki change — index.md and log.md move on every
 * refresh, and reporting all three would triple every entry.
 */
export function summarise(commits: Commit[], vault: Vault, since?: string): Change[] {
  const out: Change[] = [];
  const seenNote = new Set<NoteId>();
  const seenWiki = new Set<string>();

  // Newest first, and the newest mention of a thing is the one worth showing:
  // a note enriched twice in a night is one event to a reader.
  const ordered = [...commits].filter(byAgent)
    .filter((c) => !since || c.at > since)
    .sort((a, b) => b.at.localeCompare(a.at));

  for (const commit of ordered) {
    for (const file of commit.files) {
      if (file.status === 'D') continue;

      const tag = wikiTag(file.path);
      if (tag) {
        if (seenWiki.has(tag)) continue;
        seenWiki.add(tag);
        const wiki = vault.wikis.get(tag);
        out.push({
          kind: 'wiki', at: commit.at, sha: commit.sha, tag,
          heading: wiki?.lastChange?.heading, body: wiki?.lastChange?.body,
        });
        continue;
      }

      if (!isNotePath(file.path)) continue;
      if (seenNote.has(file.path)) continue;
      const note = vault.notes.get(file.path);
      if (!note) continue;  // enriched then deleted, or not synced to this device
      seenNote.add(file.path);
      out.push({
        kind: 'note', at: commit.at, sha: commit.sha,
        id: note.id, title: note.title || note.id, tags: note.tags,
        added: file.status === 'A',
      });
    }
  }

  return out;
}

/** For a badge. Counting entries rather than commits: one run that touched six
 *  notes is six things to look at, not one. */
export const countSince = (changes: Change[], since?: string) =>
  changes.filter((c) => !since || c.at > since).length;
