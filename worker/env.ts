import type { D1Like, R2Like } from './types.ts';

/** Bindings, plain-text vars and secrets. See README for what each one does. */
export interface Env {
  // bindings
  ASSETS: { fetch(req: Request): Promise<Response> };
  DB: D1Like;
  BUCKET?: R2Like; // only when STORAGE_DRIVER=r2

  // plain vars (wrangler.jsonc -> vars)
  PUBLIC_ORIGIN?: string; // e.g. https://netpins.xyz  (no trailing slash)
  STORAGE_DRIVER?: string; // "s3" (default) | "r2"
  S3_BUCKET?: string;
  AWS_REGION?: string;
  AWS_ROLE_ARN?: string; // enables OIDC role assumption
  OIDC_KID?: string;
  GROQ_MODEL?: string;
  GROQ_STT_MODEL?: string;
  GROQ_BUILD_MAX_TOKENS?: string;
  GROQ_INCLUDE_PREVIOUS_HTML?: string; // "true" on paid Groq tiers
  GUEST_MAX_PROJECTS?: string;
  MAX_PROJECTS_PER_USER?: string;
  AI_CALLS_GUEST_PER_DAY?: string;
  AI_CALLS_USER_PER_DAY?: string;
  BUILDS_GUEST_PER_DAY?: string;
  BUILDS_USER_PER_DAY?: string;
  STT_GUEST_PER_DAY?: string;
  STT_USER_PER_DAY?: string;

  // secrets (wrangler secret put ...)
  GROQ_API_KEY?: string;
  AUTH_SECRET?: string;
  AUTH_GITHUB_ID?: string;
  AUTH_GITHUB_SECRET?: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  OIDC_PRIVATE_KEY?: string; // PKCS8 PEM
  AWS_ACCESS_KEY_ID?: string; // fallback when not using a role
  AWS_SECRET_ACCESS_KEY?: string;
  ADMIN_TOKEN?: string; // unlocks /api/health?detail=1
}

const int = (v: string | undefined, d: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function config(env: Env) {
  return {
    storageDriver: (env.STORAGE_DRIVER ?? 's3').toLowerCase(),
    model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    sttModel: env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
    // Free Groq tier: 8K tokens/min *including* the prompt. Keep prompt + this under that.
    buildMaxTokens: int(env.GROQ_BUILD_MAX_TOKENS, 5500),
    includePreviousHtml: env.GROQ_INCLUDE_PREVIOUS_HTML === 'true',
    guestMaxProjects: int(env.GUEST_MAX_PROJECTS, 1),
    userMaxProjects: int(env.MAX_PROJECTS_PER_USER, 10),
    quota: {
      guest: {
        ai: int(env.AI_CALLS_GUEST_PER_DAY, 25),
        build: int(env.BUILDS_GUEST_PER_DAY, 5),
        stt: int(env.STT_GUEST_PER_DAY, 6),
      },
      user: {
        ai: int(env.AI_CALLS_USER_PER_DAY, 100),
        build: int(env.BUILDS_USER_PER_DAY, 15),
        stt: int(env.STT_USER_PER_DAY, 40),
      },
    },
    guestConversationsPerIpPerDay: 3,
    maxImages: 6,
    maxImageBytes: 1_500_000,
    maxAudioBytes: 12_000_000, // 5 min of opus/aac is far below this
    maxSiteBytes: 400_000,
    maxClarifyTurns: 3,
    buildStaleMs: 3 * 60_000, // a "building" row older than this is considered crashed
  };
}
export type Config = ReturnType<typeof config>;

export function publicOrigin(env: Env, req: Request): string {
  return (env.PUBLIC_ORIGIN?.replace(/\/+$/, '') || new URL(req.url).origin).toLowerCase();
}
