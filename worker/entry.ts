import { createApp } from './app.ts';
import { handleAuth, providerNames, sessionUser } from './auth.ts';
import type { Deps } from './context.ts';
import type { Env } from './env.ts';
import type { ExecLike } from './types.ts';

declare const caches: { default: Cache };

const deps: Deps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  uuid: () => crypto.randomUUID(),
  auth: { handle: handleAuth, user: sessionUser, providers: providerNames },
  cache: {
    match: (url) => caches.default.match(new Request(url)),
    put: (url, res) => caches.default.put(new Request(url), res),
  },
};

const app = createApp(deps);
export default { fetch: (req: Request, env: Env, ctx: ExecLike) => app.fetch(req, env, ctx) };
