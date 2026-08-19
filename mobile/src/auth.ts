/**
 * Signing in, so that no device ever holds a token the owner had to carry to it.
 *
 * The whole flow is redirects plus one fetch: the browser is sent to GitHub, and
 * comes back with a one-time handoff code that is redeemed for a token. The
 * token never appears in a URL, so it is not in browser history, not in a
 * Referer header, and not in anyone's access log.
 */
import { getMeta, setMeta } from './store.ts';

export const AUTH_ORIGIN = 'https://knowledge-base-auth.tilbertrampetersen.workers.dev';

interface Session {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms. GitHub gives a lifetime; an absolute instant is what we can act on. */
  expires_at?: number;
}

/** Refresh a little early: a token that expires mid-sync fails the write, not
 *  the read, and a half-pushed capture is the expensive kind of failure. */
const EARLY = 5 * 60_000;

const store = (s: Session | null) => setMeta('session', s);
const load = () => getMeta<Session>('session');

const withExpiry = (t: Record<string, unknown>): Session => ({
  access_token: String(t.access_token),
  refresh_token: t.refresh_token ? String(t.refresh_token) : undefined,
  expires_at: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : undefined,
});

export function signIn(): void {
  // Come back to this page, without whatever query is on it now.
  const back = `${location.origin}${location.pathname}`;
  location.href = `${AUTH_ORIGIN}/authorize?redirect_uri=${encodeURIComponent(back)}`;
}

/**
 * Called once on load. If GitHub has just sent the browser back, this redeems
 * the handoff and cleans the URL — leaving a spent code in the address bar
 * invites a reload that fails for no visible reason.
 */
export async function completeSignIn(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const handoff = params.get('handoff');
  if (!handoff) return false;

  history.replaceState(null, '', location.origin + location.pathname);
  const res = await fetch(`${AUTH_ORIGIN}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoff }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
  await store(withExpiry(await res.json()));
  return true;
}

export const signedIn = async () => !!(await load())?.access_token;

export async function signOut(): Promise<void> {
  await store(null);
  await setMeta('repo', null);
}

/**
 * A valid access token, refreshed if it is about to lapse.
 *
 * Every GitHub call goes through this rather than holding a token, because an
 * eight-hour token captured once at startup is a phone that stops syncing
 * halfway through the day and says nothing.
 */
export async function token(): Promise<string> {
  const session = await load();
  if (!session?.access_token) throw new Error('not signed in');
  if (!session.expires_at || Date.now() < session.expires_at - EARLY) return session.access_token;
  if (!session.refresh_token) return session.access_token;

  const res = await fetch(`${AUTH_ORIGIN}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) {
    // The refresh token is spent or revoked; the only honest recovery is to sign
    // in again, and pretending otherwise produces 401s for the rest of the day.
    await store(null);
    throw new Error('session expired — sign in again');
  }
  const next = withExpiry(await res.json());
  await store(next);
  return next.access_token;
}
