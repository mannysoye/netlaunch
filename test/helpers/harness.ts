import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createApp } from '../../worker/app.ts';
import type { Deps, SessionUser } from '../../worker/context.ts';
import type { Env } from '../../worker/env.ts';
import type { D1Like, D1Stmt } from '../../worker/types.ts';

/** D1-compatible wrapper over node:sqlite, running the real migration files. */
export function makeD1(): D1Like {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string): D1Stmt => {
    let params: unknown[] = [];
    const st: D1Stmt = {
      bind(...v) { params = v.map((x) => x ?? null); return st; },
      async first<T>() { return ((db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null); },
      async all<T>() { return { results: db.prepare(sql).all(...(params as never[])) as T[], success: true }; },
      async run() { const r = db.prepare(sql).run(...(params as never[])); return { success: true, meta: { changes: Number(r.changes) } }; },
    };
    return st;
  };
  return { prepare, async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); } };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(7)]);

export const GOOD_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sunrise Bakery</title><style>body{margin:0}@media(min-width:600px){body{font-size:18px}}</style></head><body><h1>Sunrise Bakery</h1><img src="assets/logo.png" alt="logo"></body></html>';

export interface World {
  env: Env;
  s3: Map<string, { body: Uint8Array; type: string }>;
  calls: { groq: number; sts: number; s3: string[] };
  groqHandlers: ((system: string, body: any) => Response | null)[]; // consulted in order; first non-null wins
  s3Fail: { next: number; status: number };
  sleeps: number[];
  user: SessionUser | null;
  now: number;
  fetch(path: string, init?: RequestInit & { cookie?: string; json?: unknown }): Promise<Response>;
  jar: Map<string, string>;
  tasks: Promise<unknown>[];
  settle(): Promise<void>;
}

export function chatJson(content: unknown, finish = 'stop') {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finish }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function makeWorld(envOver: Partial<Env> = {}): World {
  const s3 = new Map<string, { body: Uint8Array; type: string }>();
  const w = { s3, calls: { groq: 0, sts: 0, s3: [] as string[] }, groqHandlers: [], s3Fail: { next: 0, status: 500 }, sleeps: [] as number[], user: null as SessionUser | null, now: Date.UTC(2026, 9, 22, 12), jar: new Map<string, string>(), tasks: [] as Promise<unknown>[] } as unknown as World;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.host === 'api.groq.com') {
      w.calls.groq++;
      if (url.pathname.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: ' Hello bakery ' }), { status: 200 });
      if (url.pathname.endsWith('/models')) return new Response('{}', { status: 200 });
      const body = JSON.parse(String(init!.body));
      const system = body.messages[0].content as string;
      for (const h of w.groqHandlers) { const r = h(system, body); if (r) return r; }
      return new Response('no groq handler', { status: 500 });
    }
    if (url.host.startsWith('sts.')) { w.calls.sts++; return new Response('<R><AccessKeyId>AKIAX</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></R>'); }
    if (url.host === 'test-bucket.s3.us-east-1.amazonaws.com') {
      const h = new Headers(init?.headers);
      if (!/Credential=\w+\/\d{8}\/us-east-1\/s3\/aws4_request/.test(h.get('authorization') ?? '')) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
      const key = decodeURIComponent(url.pathname.slice(1));
      w.calls.s3.push(`${init?.method} ${key}`);
      if (w.s3Fail.next > 0 && init?.method === 'PUT') { w.s3Fail.next--; return new Response('<Error><Code>InternalError</Code></Error>', { status: w.s3Fail.status }); }
      switch (init?.method) {
        case 'PUT': {
          const copy = h.get('x-amz-copy-source');
          if (copy) { const src = s3.get(decodeURIComponent(copy.replace('/test-bucket/', ''))); if (!src) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }); s3.set(key, src); return new Response('<CopyObjectResult/>', { status: 200 }); }
          const b = init.body; s3.set(key, { body: typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b as Uint8Array), type: h.get('content-type') ?? '' });
          return new Response('', { status: 200 });
        }
        case 'GET': { const o = s3.get(key); return o ? new Response(o.body, { status: 200, headers: { 'content-type': o.type } }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }); }
        case 'HEAD': { const o = s3.get(key); return o ? new Response(null, { status: 200, headers: { 'content-length': String(o.body.byteLength), 'content-type': o.type } }) : new Response(null, { status: 404 }); }
        case 'DELETE': s3.delete(key); return new Response(null, { status: 204 });
      }
    }
    throw new Error('unexpected fetch ' + url.href);
  }) as typeof fetch;

  const deps: Deps = {
    fetch: mockFetch, now: () => w.now, sleep: async (ms) => { w.sleeps.push(ms); },
    uuid: () => crypto.randomUUID(),
    auth: { handle: async () => new Response('auth', { status: 200 }), user: async () => w.user, providers: () => ['github', 'google'] },
    cache: null,
  };
  const app = createApp(deps);
  w.env = {
    ASSETS: { fetch: async () => new Response('asset') }, DB: makeD1(), PUBLIC_ORIGIN: 'https://netpins.xyz', S3_BUCKET: 'test-bucket', AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'secret', GROQ_API_KEY: 'gsk_test', AUTH_SECRET: 'x'.repeat(40), ADMIN_TOKEN: 'adm', ...envOver,
  };
  w.fetch = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('cookie') && w.jar.size) headers.set('cookie', [...w.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    let body = init.body;
    if (init.json !== undefined) { body = JSON.stringify(init.json); headers.set('content-type', 'application/json'); }
    const req = new Request('https://netpins.xyz' + path, { ...init, headers, body });
    const res = await app.fetch(req, w.env, { waitUntil: (p) => { w.tasks.push(p); } });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(';'); const i = kv!.indexOf('='); const k = kv!.slice(0, i), v = kv!.slice(i + 1); if (/Max-Age=0/.test(sc)) w.jar.delete(k); else w.jar.set(k, v); }
    return res;
  };
  w.settle = async () => { await Promise.all(w.tasks); w.tasks.length = 0; };
  return w;
}

export async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('event:')).map((b) => {
    const [e, d] = b.split('\n'); return { event: e!.slice(7), data: JSON.parse(d!.slice(6)) };
  });
}

export const planner = (reply: any) => (system: string) => system.includes('You are NetLaunch') ? chatJson(reply) : null;
export const builder = (html: string | (() => string)) => (system: string) => system.includes('front-end designer') ? chatJson(typeof html === 'string' ? html : html()) : null;
