import { useState } from 'react';
import type { Repo } from './github.ts';

/**
 * First run. The token is checked against the repo before it is stored, because
 * the alternative is an app that looks connected and fails silently on the first
 * sync — and the usual cause is a fine-grained token missing Contents: write,
 * which is worth naming rather than making the owner guess.
 */
export function Setup({ onDone }: { onDone: (r: Repo) => Promise<string | null> }) {
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null);
    setError(await onDone({ owner: owner.trim(), name: name.trim(), branch: branch.trim() || 'main', token: token.trim() }));
    setBusy(false);
  };

  return (
    <div className="setup">
      <h1>Knowledge Base</h1>
      <p>Your vault is a git repository. This connects to it directly — nothing sits in between.</p>
      <label>Owner<input value={owner} onChange={(e) => setOwner(e.target.value)} autoCapitalize="none" placeholder="your-github-username" /></label>
      <label>Repository<input value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="none" placeholder="knowledge-base" /></label>
      <label>Branch<input value={branch} onChange={(e) => setBranch(e.target.value)} autoCapitalize="none" /></label>
      <label>Token<input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoCapitalize="none" placeholder="github_pat_…" /></label>
      <p className="hint">
        A fine-grained personal access token scoped to this one repository, with
        Contents: read and write. It is stored on this device only. Anyone who
        unlocks this phone can use it, so scope it to the vault and nothing else.
      </p>
      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={() => void submit()} disabled={busy || !owner || !name || !token}>
        {busy ? 'Checking…' : 'Connect'}
      </button>
    </div>
  );
}
