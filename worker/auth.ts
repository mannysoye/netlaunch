import { Auth } from '@auth/core';
import { getToken } from '@auth/core/jwt';
import GitHub from '@auth/core/providers/github';
import Google from '@auth/core/providers/google';
import type { Env } from './env.ts';
import { json } from './http.ts';
import type { SessionUser } from './context.ts';

/**
 * Auth.js (@auth/core) with OAuth providers and stateless, encrypted JWT sessions.
 * There are no passwords and no credential store: users sign in with GitHub or Google, and the session lives
 * in an encrypted cookie. Our own D1 database only keeps a profile row + the user's projects.
 */
export function providerNames(env: Env): string[] {
  const out: string[] = [];
  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) out.push('github');
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) out.push('google');
  return out;
}

function authConfig(env: Env) {
  const providers = [];
  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) providers.push(GitHub({ clientId: env.AUTH_GITHUB_ID, clientSecret: env.AUTH_GITHUB_SECRET }));
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) providers.push(Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }));
  return {
    basePath: '/api/auth',
    secret: env.AUTH_SECRET,
    trustHost: true,
    providers,
    session: { strategy: 'jwt' as const, maxAge: 30 * 24 * 60 * 60 },
    pages: { signIn: '/', error: '/' }, // the SPA handles both; errors arrive as /?error=...
    callbacks: {
      async jwt({ token, account }: { token: Record<string, unknown>; account?: { provider: string; providerAccountId: string } | null }) {
        if (account) token.uid = `${account.provider}:${account.providerAccountId}`; // stable, provider-scoped id
        return token;
      },
    },
  };
}

export async function handleAuth(req: Request, env: Env): Promise<Response> {
  if (!env.AUTH_SECRET) return json({ error: { code: 'not_configured', message: 'AUTH_SECRET is not set.', retryable: false } }, 503);
  if (providerNames(env).length === 0) return json({ error: { code: 'not_configured', message: 'No sign-in providers are configured.', retryable: false } }, 503);
  return Auth(req, authConfig(env) as Parameters<typeof Auth>[1]);
}

export async function sessionUser(req: Request, env: Env): Promise<SessionUser | null> {
  if (!env.AUTH_SECRET) return null;
  const cookie = req.headers.get('cookie') ?? '';
  if (!cookie.includes('authjs.session-token')) return null; // fast path for guests: skip crypto entirely
  const secure = new URL(req.url).protocol === 'https:';
  const cookieName = secure ? '__Secure-authjs.session-token' : 'authjs.session-token';
  try {
    const token = await getToken({ req, secret: env.AUTH_SECRET, secureCookie: secure, cookieName, salt: cookieName });
    if (!token || typeof token.uid !== 'string') return null;
    return { id: token.uid, name: (token.name as string) ?? null, email: (token.email as string) ?? null, image: (token.picture as string) ?? null };
  } catch {
    return null; // tampered/expired cookie => treat as signed out
  }
}
