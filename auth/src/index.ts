/**
 * The only server this product has.
 *
 * It exists for one reason: GitHub's token endpoints send no CORS headers, so a
 * browser cannot exchange an authorization code by itself. Everything else —
 * reading the vault, writing notes, search, synthesis — happens on the device or
 * in the nightly job, and deliberately does not pass through here.
 *
 * What it holds: the GitHub App's client secret. What it never holds: a user's
 * vault credential. Tokens are minted for the device, returned once, and stored
 * on the device. There is no user table here, because an account system whose
 * only job is to remember a GitHub identity is a second copy of GitHub.
 */

export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Comma-separated origins allowed to redeem codes and refresh tokens. */
  ALLOWED_ORIGINS: string;
  /** Short-lived one-time codes, so a token never travels in a URL. */
  HANDOFF: KVNamespace;
}

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';

/** 60s is generous for a redirect the browser performs immediately, and short
 *  enough that a code left in history or a proxy log is already useless. */
const HANDOFF_TTL = 60;

const origins = (env: Env) => env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

function cors(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !origins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body: unknown, init: ResponseInit = {}, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra, ...init.headers },
  });

/** GitHub answers the token endpoint with form encoding unless asked otherwise,
 *  and reports failures with HTTP 200 and an `error` field. */
async function exchange(env: Env, params: Record<string, string>) {
  const res = await fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  const body = await res.json<Record<string, string>>().catch(() => ({}) as Record<string, string>);
  if (!res.ok || body.error) throw new Error(body.error_description || body.error || `github ${res.status}`);
  return body;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = cors(env, request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    // ── start ────────────────────────────────────────────────────────────────
    // The client sends the user here. This is a redirect rather than a fetch, so
    // no CORS is involved and the client secret stays on this side.
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      if (!origins(env).some((o) => redirect.startsWith(o))) {
        return json({ error: 'redirect_uri is not an allowed origin' }, { status: 400 });
      }
      // `state` carries where to come back to, signed by nothing — it is not a
      // secret, and it is validated against the allow-list above on the way back.
      const state = crypto.randomUUID();
      await env.HANDOFF.put(`state:${state}`, redirect, { expirationTtl: 600 });

      const to = new URL(GITHUB_AUTHORIZE);
      to.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
      to.searchParams.set('state', state);
      to.searchParams.set('redirect_uri', `${url.origin}/callback`);
      return Response.redirect(to.toString(), 302);
    }

    // ── GitHub comes back here ───────────────────────────────────────────────
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return new Response('missing code or state', { status: 400 });

      const redirect = await env.HANDOFF.get(`state:${state}`);
      if (!redirect) return new Response('state expired or unknown', { status: 400 });
      await env.HANDOFF.delete(`state:${state}`);

      let token: Record<string, string>;
      try {
        token = await exchange(env, { code, redirect_uri: `${url.origin}/callback` });
      } catch (e) {
        return new Response(`token exchange failed: ${e instanceof Error ? e.message : e}`, { status: 502 });
      }

      // The token is handed over by reference, not by value. A single-use code in
      // the query string is spent within seconds; the token itself never appears
      // in a URL, in browser history, or in a Referer header.
      const handoff = crypto.randomUUID();
      await env.HANDOFF.put(`handoff:${handoff}`, JSON.stringify(token), { expirationTtl: HANDOFF_TTL });

      const back = new URL(redirect);
      back.searchParams.set('handoff', handoff);
      return Response.redirect(back.toString(), 302);
    }

    // ── the client redeems the one-time code ─────────────────────────────────
    if (url.pathname === '/redeem' && request.method === 'POST') {
      if (!headers['Access-Control-Allow-Origin']) return json({ error: 'origin not allowed' }, { status: 403 });
      const { handoff } = await request.json<{ handoff?: string }>().catch(() => ({ handoff: undefined }));
      if (!handoff) return json({ error: 'missing handoff' }, { status: 400, headers }, headers);

      const stored = await env.HANDOFF.get(`handoff:${handoff}`);
      if (!stored) return json({ error: 'handoff expired or already used' }, { status: 410 }, headers);
      await env.HANDOFF.delete(`handoff:${handoff}`);
      return json(JSON.parse(stored), {}, headers);
    }

    // ── refresh ──────────────────────────────────────────────────────────────
    // GitHub App user tokens last 8 hours. Without this the app would ask for a
    // login every working day, which is the thing this whole exercise removes.
    if (url.pathname === '/refresh' && request.method === 'POST') {
      if (!headers['Access-Control-Allow-Origin']) return json({ error: 'origin not allowed' }, { status: 403 });
      const { refresh_token } = await request.json<{ refresh_token?: string }>().catch(() => ({ refresh_token: undefined }));
      if (!refresh_token) return json({ error: 'missing refresh_token' }, { status: 400 }, headers);
      try {
        return json(await exchange(env, { grant_type: 'refresh_token', refresh_token }), {}, headers);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 401 }, headers);
      }
    }

    if (url.pathname === '/health') return json({ ok: true, clientId: !!env.GITHUB_CLIENT_ID });

    return new Response('not found', { status: 404 });
  },
};
