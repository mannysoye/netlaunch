import type { Config, Env } from './env.ts';
import { AppError, b64url } from './http.ts';
import type { Repo } from './db.ts';
import type { Storage } from './storage/types.ts';
import type { ExecLike } from './types.ts';

export interface SessionUser { id: string; name?: string | null; email?: string | null; image?: string | null }
export interface Identity { kind: 'guest' | 'user'; id: string; name?: string | null; email?: string | null; image?: string | null }

/** Everything with side effects or platform dependence is injected, so the whole app runs in plain Node tests. */
export interface Deps {
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  uuid(): string;
  auth: {
    handle(req: Request, env: Env): Promise<Response>;
    user(req: Request, env: Env): Promise<SessionUser | null>;
    providers(env: Env): string[];
  };
  cache: { match(url: string): Promise<Response | undefined>; put(url: string, res: Response): Promise<void> } | null;
}

export interface Ctx {
  req: Request;
  env: Env;
  exec: ExecLike;
  url: URL;
  params: Record<string, string>;
  deps: Deps;
  cfg: Config;
  repo: Repo;
  origin: string;
  requestId: string;
  identity: Identity;
  cookies: string[]; // Set-Cookie values to attach to the response
  storage(): Storage;
}

export type Handler = (c: Ctx) => Promise<Response> | Response;

/* ------------------------------ router ------------------------------ */
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

/* ----------------------------- guest identity ----------------------------- */
const GUEST_COOKIE = 'nl_guest';
const enc = new TextEncoder();

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function readCookie(req: Request, name: string): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1]! : null;
}

export async function readGuestId(req: Request, secret: string): Promise<string | null> {
  const raw = readCookie(req, GUEST_COOKIE);
  if (!raw) return null;
  const [id, sig] = raw.split('.');
  if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const expected = await sign(secret, id);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? `guest:${id}` : null;
}

export async function guestCookie(uuid: string, secret: string, secure: boolean): Promise<string> {
  return `${GUEST_COOKIE}=${uuid}.${await sign(secret, uuid)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
export const clearGuestCookie = (secure: boolean): string =>
  `${GUEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

export function requireSecret(env: Env): string {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 16) throw new AppError('not_configured', 'AUTH_SECRET is missing or too short (run: openssl rand -base64 33).', 500);
  return env.AUTH_SECRET;
}

/** Resolve who is calling: signed-in user, existing guest, or mint a new guest. Claims guest data on sign-in. */
export async function resolveIdentity(c: Omit<Ctx, 'identity'>): Promise<Identity> {
  const secret = requireSecret(c.env);
  const secure = c.url.protocol === 'https:';
  const user = await c.deps.auth.user(c.req, c.env);
  const guestId = await readGuestId(c.req, secret);
  if (user) {
    if (guestId) {
      await c.repo.claimGuest(guestId, user.id, c.deps.now());
      c.cookies.push(clearGuestCookie(secure));
    }
    return { kind: 'user', ...user };
  }
  if (guestId) return { kind: 'guest', id: guestId };
  const uuid = c.deps.uuid();
  c.cookies.push(await guestCookie(uuid, secret, secure));
  return { kind: 'guest', id: `guest:${uuid}` };
}

/** Daily quota check (atomic). Throws a friendly error when exhausted. */
export async function enforce(c: Ctx, kind: 'ai' | 'build' | 'stt'): Promise<void> {
  const limit = c.cfg.quota[c.identity.kind][kind];
  const ok = await c.repo.consume(c.identity.id, kind, limit, c.deps.now());
  if (!ok) {
    const what = kind === 'stt' ? 'voice memos' : kind === 'build' ? 'site builds' : 'AI messages';
    throw new AppError('quota_exceeded',
      c.identity.kind === 'guest'
        ? `You’ve used today’s free ${what}. Create a free account for more, or come back tomorrow.`
        : `You’ve reached today’s limit of ${what}. It resets at midnight UTC.`, 429);
  }
}
