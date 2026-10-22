export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/** Top-level paths owned by the app itself (routes, static folders and files). */
const RESERVED = new Set([
  'api', 'assets', 'icons', 'static', 'public', 'well-known', 'sw', 'manifest', 'favicon',
  'robots', 'sitemap', 'offline', 'index', 'health', 'auth', 'app', 'www', 'mail', 'blog',
  'docs', 'help', 'about', 'terms', 'privacy', 'status', 'settings', 'dashboard', 'new',
  'netlaunch', 'netpins', 'null', 'undefined', 'download', 'downloads', 'uploads', 'me',
]);

/** Words that make pages convincing phishing targets. Matched per hyphen-separated token. */
const BLOCKED_TOKENS = new Set([
  'paypal', 'apple', 'google', 'microsoft', 'amazon', 'facebook', 'instagram', 'whatsapp',
  'binance', 'coinbase', 'netflix', 'login', 'signin', 'signup', 'verify', 'secure',
  'wallet', 'admin', 'support', 'billing', 'password',
]);

export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type SlugCheck =
  | { ok: true; slug: string }
  | { ok: false; slug: string; reason: string };

export function checkSlug(input: string): SlugCheck {
  const slug = normalizeSlug(String(input ?? ''));
  if (slug.length < SLUG_MIN) return { ok: false, slug, reason: `Use at least ${SLUG_MIN} letters or numbers.` };
  if (slug.length > SLUG_MAX) return { ok: false, slug, reason: `Keep it under ${SLUG_MAX} characters.` };
  if (RESERVED.has(slug)) return { ok: false, slug, reason: 'That name is reserved. Try another.' };
  if (slug.split('-').some((t) => BLOCKED_TOKENS.has(t))) {
    return { ok: false, slug, reason: 'That name isn’t allowed. Try something more specific to your site.' };
  }
  return { ok: true, slug };
}

/** True if a URL path segment could be a published site (used by the router before hitting storage). */
export function looksLikeSlug(segment: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(segment) && !segment.includes('--') && !RESERVED.has(segment);
}
