/**
 * The vault over GitHub's REST API.
 *
 * The desktop app shells out to system git. A browser cannot, and the obvious
 * substitute — isomorphic-git — cannot either without a CORS proxy, because
 * GitHub sends no CORS headers on the git smart-HTTP endpoints. That proxy would
 * see every byte of the vault. The REST API *does* send CORS headers, so this
 * talks to it directly and nothing sits in the middle.
 *
 * The cost is a fine-grained token living on the phone. That is the free tier's
 * own bargain (your repo, your key); the hosted tier replaces this file with a
 * server that holds the credential instead, which is why VaultSource is the seam.
 */

export interface Repo {
  owner: string;
  name: string;
  branch: string;
  token: string;
}

/** A file as git sees it: a path and the hash of its content. */
export interface Entry {
  path: string;
  sha: string;
  size: number;
}

export interface Snapshot {
  commit: string;
  entries: Entry[];
}

const API = 'https://api.github.com';

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(repo: Repo, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${repo.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 200);
    try { detail = JSON.parse(body).message ?? detail; } catch { /* keep the raw text */ }
    throw new GitHubError(`${res.status} ${detail}`, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * Every path and content hash in the vault, in one request.
 *
 * This is what makes syncing a phone over cellular reasonable: the tree is a few
 * kilobytes however large the vault is, and comparing hashes locally says
 * exactly which files to download. Listing by walking directories would be one
 * request per folder, and fetching every file to find the changed ones would be
 * the whole vault every time.
 */
export async function snapshot(repo: Repo): Promise<Snapshot> {
  const branch = await call<{ commit: { sha: string } }>(
    repo, `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.branch)}`);
  const tree = await call<{ truncated: boolean; tree: { path: string; type: string; sha: string; size?: number }[] }>(
    repo, `/repos/${repo.owner}/${repo.name}/git/trees/${branch.commit.sha}?recursive=1`);
  if (tree.truncated) {
    // GitHub caps a recursive tree at 100k entries. Silently syncing a partial
    // vault would look like notes had been deleted, so refuse instead.
    throw new GitHubError('vault is too large for a single tree listing', 422);
  }
  return {
    commit: branch.commit.sha,
    // Dotted directories hold tooling — skills, editor config — which the phone
    // has no use for and should not spend cellular data on.
    entries: tree.tree
      .filter((e) => e.type === 'blob' && e.path.endsWith('.md')
        && !e.path.split('/').some((seg) => seg.startsWith('.')))
      .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })),
  };
}

const decodeBase64 = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

const encodeBase64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** Blobs are addressed by hash, so this is safe to run concurrently and to cache
 *  forever — a given sha's content never changes. */
export const readBlob = (repo: Repo, sha: string) =>
  call<{ content: string }>(repo, `/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`)
    .then((b) => decodeBase64(b.content));

/**
 * Write a file. `sha` is the blob being replaced and is what makes this safe:
 * GitHub rejects the write if the file moved on since it was read, rather than
 * silently overwriting an edit made on the desktop or by the enrichment job.
 */
export async function putFile(
  repo: Repo, path: string, content: string, sha: string | undefined, message: string,
): Promise<{ sha: string; commit: string }> {
  const res = await call<{ content: { sha: string }; commit: { sha: string } }>(
    repo, `/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'PUT',
      body: JSON.stringify({ message, content: encodeBase64(content), sha, branch: repo.branch }),
    });
  return { sha: res.content.sha, commit: res.commit.sha };
}

/** Confirms the token works and the repo is writable, before anything is stored. */
export async function checkAccess(repo: Repo): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const r = await call<{ permissions?: { push?: boolean } }>(
      repo, `/repos/${repo.owner}/${repo.name}`);
    if (r.permissions && !r.permissions.push) {
      return { ok: false, reason: 'token can read this repo but not write to it' };
    }
    await call(repo, `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.branch)}`);
    return { ok: true };
  } catch (e) {
    const status = e instanceof GitHubError ? e.status : 0;
    if (status === 401) return { ok: false, reason: 'token rejected' };
    if (status === 404) return { ok: false, reason: 'repo or branch not found, or token lacks access to it' };
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
