import { Router, resolveIdentity } from './context.ts';
import type { Ctx, Deps } from './context.ts';
import { config, publicOrigin } from './env.ts';
import type { Env } from './env.ts';
import { createRepo } from './db.ts';
import { AppError, errorResponse, json } from './http.ts';
import { registerBuildRoute } from './routes/build.ts';
import { registerConversationRoutes } from './routes/conversations.ts';
import { registerHealthRoute, registerOidcRoutes, serveSite } from './routes/system.ts';
import { createStorage } from './storage/index.ts';
import type { ExecLike } from './types.ts';

/** Builds the Worker's fetch handler. All platform-specific things arrive through `deps`. */
export function createApp(deps: Deps) {
  const router = new Router();
  registerHealthRoute(router);
  registerOidcRoutes(router);
  registerConversationRoutes(router);
  registerBuildRoute(router);

  /** Same-origin only for state-changing requests (defence in depth on top of SameSite=Lax cookies). */
  function originAllowed(req: Request, url: URL, origin: string): boolean {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const o = req.headers.get('origin');
    if (!o) return true; // non-browser clients; cookies can't be attached cross-site without an Origin anyway
    try {
      const got = new URL(o).origin.toLowerCase();
      return got === url.origin.toLowerCase() || got === origin;
    } catch {
      return false;
    }
  }

  return {
    async fetch(req: Request, env: Env, exec: ExecLike): Promise<Response> {
      const requestId = deps.uuid().slice(0, 8);
      try {
        const url = new URL(req.url);
        const path = url.pathname;
        const origin = publicOrigin(env, req);

        if (path.startsWith('/api/auth/')) return await deps.auth.handle(req, env);

        const base = {
          req, env, exec, url, params: {}, deps, cfg: config(env), repo: createRepo(env.DB), origin, requestId, cookies: [] as string[],
          storage: () => createStorage(env, origin, { fetch: deps.fetch, sleep: deps.sleep, now: deps.now }),
        };

        const isApi = path.startsWith('/api/') || path.startsWith('/.well-known/');
        if (!isApi) return await serveSite(base);

        if (!originAllowed(req, url, origin)) throw new AppError('forbidden', 'Cross-site requests are not allowed.', 403);
        const m = router.match(req.method, path);
        if (m === null) return json({ error: { code: 'not_found', message: 'Unknown API route.', retryable: false, requestId } }, 404);
        if (m === 'method') return json({ error: { code: 'bad_request', message: 'Method not allowed.', retryable: false, requestId } }, 405);

        const needsIdentity = !(path === '/api/health' || path.startsWith('/.well-known/'));
        const ctx = { ...base, params: m.params } as Ctx;
        if (needsIdentity) ctx.identity = await resolveIdentity(base);

        const res = await m.handler(ctx);
        if (base.cookies.length === 0) return res;
        const out = new Response(res.body, res);
        for (const c of base.cookies) out.headers.append('set-cookie', c);
        return out;
      } catch (e) {
        return errorResponse(e, requestId);
      }
    },
  };
}
