import { publicJwk } from '../storage/creds.ts';
import type { Ctx, Deps, Router } from '../context.ts';
import type { Env } from '../env.ts';
import { looksLikeSlug } from '../domain/slug.ts';
import { AppError, json } from '../http.ts';
import { createStorage } from '../storage/index.ts';
import { siteKey } from '../storage/types.ts';

/* ----------------------------- published sites -----------------------------
 * User-generated pages are served from the SAME origin as the app, so they must never be able to touch the
 * app's cookies or APIs. `Content-Security-Policy: sandbox` (without allow-same-origin) gives every published
 * page an opaque origin: scripts still run, but cannot read cookies/storage or call our API with credentials.
 */
const SITE_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const ALLOWED_ASSET = /^assets\/[a-z0-9][a-z0-9._-]{0,80}\.(png|jpg|jpeg|webp|gif)$/;

function notFoundPage(origin: string): Response {
  const host = origin.replace(/^https?:\/\//, '');
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1320;color:#e6edf6;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}a{color:#45a2e5}</style></head>
<body><main><h1>Nothing here yet</h1><p>This page doesn’t exist, or it hasn’t been published.</p><p><a href="${origin}/">Build yours on ${host}</a></p></main></body></html>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=30', 'content-security-policy': SITE_CSP, 'x-content-type-options': 'nosniff' } },
  );
}

export async function serveSite(c: Pick<Ctx, 'req' | 'url' | 'env' | 'deps' | 'exec' | 'origin' | 'storage'>): Promise<Response> {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  const parts = c.url.pathname.split('/').filter(Boolean);
  const slug = parts[0] ?? '';
  if (!looksLikeSlug(slug)) return notFoundPage(c.origin);

  if (parts.length === 1 && !c.url.pathname.endsWith('/')) {
    // Relative asset URLs only resolve correctly under /slug/ so normalise to the trailing slash.
    return new Response(null, { status: 301, headers: { location: `/${slug}/${c.url.search}`, 'cache-control': 'public, max-age=300' } });
  }
  const rest = parts.slice(1).join('/');
  const path = rest === '' ? 'index.html' : rest;
  if (path !== 'index.html' && !ALLOWED_ASSET.test(path)) return notFoundPage(c.origin);

  const bypass = /no-cache|no-store/.test(c.req.headers.get('cache-control') ?? '');
  const cacheUrl = `${c.origin}/${slug}/${path === 'index.html' ? '' : path}`;
  if (c.deps.cache && !bypass) {
    const hit = await c.deps.cache.match(cacheUrl);
    if (hit) return c.req.method === 'HEAD' ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
  }

  const obj = await c.storage().get(siteKey(slug, path));
  if (!obj) return notFoundPage(c.origin);
  const isHtml = path === 'index.html';
  const res = new Response(c.req.method === 'HEAD' ? null : obj.body, {
    headers: {
      'content-type': isHtml ? 'text/html; charset=utf-8' : obj.contentType,
      'cache-control': isHtml ? 'public, max-age=60' : 'public, max-age=86400',
      'content-security-policy': SITE_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
  if (c.deps.cache && !bypass && c.req.method === 'GET') c.exec.waitUntil(c.deps.cache.put(cacheUrl, res.clone()));
  return res;
}

/* ------------------------------ OIDC discovery ------------------------------ */
export function registerOidcRoutes(r: Router) {
  r.get('/.well-known/openid-configuration', (c) => {
    if (!c.env.OIDC_PRIVATE_KEY) throw new AppError('not_found', 'OIDC is not enabled.', 404);
    return json({
      issuer: c.origin, jwks_uri: `${c.origin}/.well-known/jwks.json`, response_types_supported: ['id_token'],
      subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    }, 200, { 'cache-control': 'public, max-age=300' });
  });
  r.get('/.well-known/jwks.json', async (c) => {
    if (!c.env.OIDC_PRIVATE_KEY) throw new AppError('not_found', 'OIDC is not enabled.', 404);
    return json({ keys: [await publicJwk(c.env.OIDC_PRIVATE_KEY, c.env.OIDC_KID ?? 'netlaunch-1')] }, 200, { 'cache-control': 'public, max-age=300' });
  });
}

/* --------------------------------- health --------------------------------- */
interface Check { name: string; ok: boolean; detail?: string }

async function step(name: string, fn: () => Promise<string | void>): Promise<Check> {
  try { return { name, ok: true, detail: (await fn()) || undefined }; }
  catch (e) { return { name, ok: false, detail: (e as Error).message }; }
}

export function registerHealthRoute(r: Router) {
  r.get('/api/health', async (c) => {
    const detail = c.url.searchParams.get('detail') === '1';
    if (!detail) return json({ ok: true });
    const token = c.req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) throw new AppError('unauthorized', 'Set ADMIN_TOKEN and send it as a Bearer token to see details.', 401);
    return json(await doctor(c.env, c.origin, c.deps));
  });
}

/** Exercises every external dependency once. Run it right after deploying. */
export async function doctor(env: Env, origin: string, deps: Deps) {
  const checks: Check[] = [];
  checks.push(await step('D1 database', async () => { await env.DB.prepare('SELECT COUNT(*) AS n FROM conversations').first(); }));
  checks.push(await step('AUTH_SECRET', async () => { if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 16) throw new Error('missing or shorter than 16 chars'); }));
  checks.push(await step('Sign-in providers', async () => {
    const p = deps.auth.providers(env);
    if (!p.length) throw new Error('none configured (guests only). Set AUTH_GITHUB_* and/or AUTH_GOOGLE_*');
    return p.join(', ');
  }));
  checks.push(await step('Groq API key', async () => {
    if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
    const res = await deps.fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${env.GROQ_API_KEY}` } });
    if (!res.ok) throw new Error(`Groq responded ${res.status}`);
    return 'key accepted';
  }));
  checks.push(await step('Storage read/write/delete', async () => {
    const st = createStorage(env, origin, { fetch: deps.fetch, sleep: deps.sleep, now: deps.now });
    const key = `healthcheck/${deps.uuid()}.txt`;
    await st.put(key, 'ok', { contentType: 'text/plain' });
    const got = await st.get(key);
    if (!got) throw new Error('wrote an object but could not read it back');
    await st.delete(key);
    return (env.STORAGE_DRIVER ?? 's3') === 'r2' ? 'R2' : env.AWS_ROLE_ARN && env.OIDC_PRIVATE_KEY ? 'S3 via IAM role (OIDC)' : 'S3 via access keys';
  }));
  return { ok: checks.every((x) => x.ok), checks };
}
