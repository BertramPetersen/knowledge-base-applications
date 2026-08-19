import { useEffect, useState } from 'react';
import { signIn } from './auth.ts';
import { listRepos, viewer, type RepoRef, type TokenSource } from './github.ts';

/**
 * First run, in two steps and no typing.
 *
 * Step one is a sign-in, which replaces pasting a personal access token onto
 * every device the owner uses. Step two is picking a vault from the
 * repositories the App was installed on — the owner already answered that
 * question at install time, so this is a list, not a form.
 */
export function Setup({ auth, signedIn, onPick }: {
  auth: TokenSource;
  signedIn: boolean;
  onPick: (r: RepoRef) => Promise<string | null>;
}) {
  const [repos, setRepos] = useState<RepoRef[] | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!signedIn) return;
    void (async () => {
      try {
        setWho((await viewer(auth)).login);
        setRepos(await listRepos(auth));
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, [signedIn, auth]);

  const pick = async (r: RepoRef) => {
    setBusy(true); setError(null);
    setError(await onPick(r));
    setBusy(false);
  };

  if (!signedIn) {
    return (
      <div className="setup">
        <h1>Knowledge Base</h1>
        <p>Your vault is a git repository. Sign in and this device reads it directly — nothing sits in between, and no token to carry across from your laptop.</p>
        <button className="primary" onClick={signIn}>Sign in with GitHub</button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="setup">
      <h1>Choose your vault</h1>
      <p>{who ? `Signed in as ${who}.` : 'Signed in.'} These are the repositories the app was given access to.</p>
      {error && <p className="error">{error}</p>}
      {repos === null && !error && <p className="hint">Looking…</p>}
      {repos?.length === 0 && (
        <p className="hint">
          The app is not installed on any repository yet. Install it on your vault
          from GitHub, then come back and pull to refresh.
        </p>
      )}
      {repos?.map((r) => (
        <button key={`${r.owner}/${r.name}`} className="repo" disabled={busy} onClick={() => void pick(r)}>
          <span className="repo-name">{r.owner}/{r.name}</span>
          <span className="repo-branch">{r.branch}</span>
        </button>
      ))}
    </div>
  );
}
