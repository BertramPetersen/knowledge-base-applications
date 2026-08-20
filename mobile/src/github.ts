/**
 * The vault over GitHub's REST API.
 *
 * The desktop app shells out to system git. A browser cannot, and the obvious
 * substitute — isomorphic-git — cannot either without a CORS proxy, because
 * GitHub sends no CORS headers on the git smart-HTTP endpoints. That proxy would
 * see every byte of the vault. The REST API *does* send CORS headers, so this
 * talks to it directly and nothing sits in the middle.
 *
 * The credential is a GitHub App user token obtained by signing in, kept only on
 * the device. Nothing here knows how it was minted — it asks for one per
 * request, which is what lets it be refreshed underneath.
 */

/** Which repository. Deliberately carries no credential: the same reference is
 *  meaningful in the UI, in storage, and in a log line. */
export interface RepoRef {
  owner: string;
  name: string;
  branch: string;
}

/** Asked for on every call, so an expiring token refreshes without callers
 *  knowing it happened. */
export type TokenSource = () => Promise<string>;

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

async function call<T>(auth: TokenSource, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await auth()}`,
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

/** Who is signed in, shown in the UI so it is never ambiguous which account a
 *  device is acting as. */
export const viewer = (auth: TokenSource) =>
  call<{ login: string; avatar_url: string }>(auth, '/user');

/**
 * The repositories this App may touch.
 *
 * A GitHub App is installed on chosen repositories, so the owner has already
 * said which vault this is. Asking them to type its name on every device is
 * asking a question that has been answered.
 */
export async function listRepos(auth: TokenSource): Promise<RepoRef[]> {
  const { installations } = await call<{ installations: { id: number }[] }>(auth, '/user/installations');
  const perInstall = await Promise.all(installations.map((i) =>
    call<{ repositories: { name: string; owner: { login: string }; default_branch: string }[] }>(
      auth, `/user/installations/${i.id}/repositories?per_page=100`)));
  return perInstall
    .flatMap((r) => r.repositories)
    .map((r) => ({ owner: r.owner.login, name: r.name, branch: r.default_branch }))
    .sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
}

/**
 * Recent commits and the files each touched.
 *
 * Two round-trips per commit is the price of the REST API: the list endpoint
 * omits file lists, so each commit has to be fetched. Bounded to a handful,
 * because this answers "what happened lately", and lately is short.
 */
export async function listCommits(auth: TokenSource, repo: RepoRef, limit = 15) {
  const list = await call<{ sha: string }[]>(
    auth, `/repos/${repo.owner}/${repo.name}/commits?sha=${encodeURIComponent(repo.branch)}&per_page=${limit}`);
  const full = await Promise.all(list.map((c) =>
    call<{
      sha: string; commit: { author: { name: string; email: string; date: string }; message: string };
      files?: { filename: string; status: string }[];
    }>(auth, `/repos/${repo.owner}/${repo.name}/commits/${c.sha}`)));
  return full.map((c) => ({
    sha: c.sha,
    author: `${c.commit.author.name} <${c.commit.author.email}>`,
    message: c.commit.message.split('\n')[0],
    at: c.commit.author.date,
    files: (c.files ?? []).map((f) => ({
      path: f.filename,
      // GitHub spells them out; the shared model uses git's own letters.
      status: (f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M') as 'A' | 'M' | 'D',
    })),
  }));
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
export async function snapshot(auth: TokenSource, repo: RepoRef): Promise<Snapshot> {
  const branch = await call<{ commit: { sha: string } }>(
    auth, `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.branch)}`);
  const tree = await call<{ truncated: boolean; tree: { path: string; type: string; sha: string; size?: number }[] }>(
    auth, `/repos/${repo.owner}/${repo.name}/git/trees/${branch.commit.sha}?recursive=1`);
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
export const readBlob = (auth: TokenSource, repo: RepoRef, sha: string) =>
  call<{ content: string }>(auth, `/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`)
    .then((b) => decodeBase64(b.content));

/**
 * Write a file. `sha` is the blob being replaced and is what makes this safe:
 * GitHub rejects the write if the file moved on since it was read, rather than
 * silently overwriting an edit made on the desktop or by the enrichment job.
 */
export async function putFile(
  auth: TokenSource, repo: RepoRef, path: string, content: string, sha: string | undefined, message: string,
): Promise<{ sha: string; commit: string }> {
  const res = await call<{ content: { sha: string }; commit: { sha: string } }>(
    auth, `/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'PUT',
      body: JSON.stringify({ message, content: encodeBase64(content), sha, branch: repo.branch }),
    });
  return { sha: res.content.sha, commit: res.commit.sha };
}

/** Confirms the chosen repo is reachable and writable before anything is stored. */
export async function checkAccess(auth: TokenSource, repo: RepoRef): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const r = await call<{ permissions?: { push?: boolean } }>(auth, `/repos/${repo.owner}/${repo.name}`);
    if (r.permissions && !r.permissions.push) {
      return { ok: false, reason: 'the app can read this repository but not write to it' };
    }
    await call(auth, `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.branch)}`);
    return { ok: true };
  } catch (e) {
    const status = e instanceof GitHubError ? e.status : 0;
    if (status === 401) return { ok: false, reason: 'sign-in expired' };
    if (status === 404) return { ok: false, reason: 'repository or branch not found, or the app is not installed on it' };
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
