import { snapshot, readBlob, putFile, GitHubError, type RepoRef, type TokenSource } from './github.ts';
import { allFiles, getFile, putCached, removeFile, getMeta, setMeta } from './store.ts';

export interface SyncResult {
  pulled: number;
  pushed: number;
  deleted: number;
  conflicts: string[];
  commit?: string;
  message: string;
}

/** Concurrency, not because GitHub is slow, but because a phone on cellular has
 *  round-trip latency measured in hundreds of milliseconds. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * Local writes go first.
 *
 * Pulling first would overwrite an unpushed capture with the server's older
 * copy and lose it silently — the one failure a notes app must never have. A
 * write rejected because the file moved on is reported as a conflict and left
 * dirty rather than resolved by guessing.
 */
async function push(auth: TokenSource, repo: RepoRef): Promise<Pick<SyncResult, 'pushed' | 'conflicts'>> {
  const dirty = (await allFiles()).filter((f) => f.dirty);
  const conflicts: string[] = [];
  let pushed = 0;

  for (const file of dirty) {
    try {
      const { sha } = await putFile(auth, repo, file.path, file.text, file.sha,
        `mobile: ${file.path.split('/').pop()}`);
      await putCached({ path: file.path, sha, text: file.text });
      pushed++;
    } catch (e) {
      // 409 and 422 both mean "the sha you named is not current".
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) conflicts.push(file.path);
      else throw e;
    }
  }
  return { pushed, conflicts };
}

export async function sync(auth: TokenSource, repo: RepoRef): Promise<SyncResult> {
  const { pushed, conflicts } = await push(auth, repo);

  const remote = await snapshot(auth, repo);
  const local = new Map((await allFiles()).map((f) => [f.path, f]));
  const wanted = new Set(remote.entries.map((e) => e.path));

  // Only what actually changed. The tree gave content hashes, so this is exact
  // rather than a heuristic on modification times.
  const stale = remote.entries.filter((e) => {
    const have = local.get(e.path);
    return !have || (have.sha !== e.sha && !have.dirty);
  });

  await pool(stale, 6, async (e) => {
    const text = await readBlob(auth, repo, e.sha);
    await putCached({ path: e.path, sha: e.sha, text });
  });

  // A file gone from the tree was deleted upstream — unless it is a local
  // capture that has never been pushed, which has no business being removed.
  let deleted = 0;
  for (const [path, file] of local) {
    if (!wanted.has(path) && !file.dirty) { await removeFile(path); deleted++; }
  }

  await setMeta('commit', remote.commit);
  await setMeta('syncedAt', new Date().toISOString());

  const parts = [
    stale.length ? `${stale.length} updated` : '',
    pushed ? `${pushed} pushed` : '',
    deleted ? `${deleted} removed` : '',
    conflicts.length ? `${conflicts.length} conflicted` : '',
  ].filter(Boolean);

  return {
    pulled: stale.length, pushed, deleted, conflicts, commit: remote.commit,
    message: parts.length ? parts.join(', ') : 'up to date',
  };
}

export const lastSynced = () => getMeta<string>('syncedAt');

/** Notes the owner has opened, and when. The revisit surface is built on this,
 *  and it is deliberately local: what you have looked at on your phone is not
 *  something the vault needs to carry. */
export async function markSeen(path: string): Promise<void> {
  const seen = (await getMeta<Record<string, string>>('seen')) ?? {};
  seen[path] = new Date().toISOString();
  await setMeta('seen', seen);
}

export const seenMap = async () => (await getMeta<Record<string, string>>('seen')) ?? {};
