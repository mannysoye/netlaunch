/** Pure functions for handling model-generated HTML. No I/O, fully unit-tested. */

export interface Extracted {
  html: string;
  complete: boolean; // false => the model was cut off before </html>
}

export function extractHtml(raw: string): Extracted | null {
  let t = raw.trim();
  // Some models wrap the document in JSON despite instructions.
  if (t.startsWith('{') && /"html"\s*:/.test(t)) {
    try {
      const o = JSON.parse(t) as { html?: unknown };
      if (typeof o.html === 'string') t = o.html.trim();
    } catch { /* fall through */ }
  }
  t = t.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '').replace(/\r?\n?```[ \t]*$/, '');
  const lower = t.toLowerCase();
  let start = lower.indexOf('<!doctype html');
  if (start < 0) start = lower.indexOf('<html');
  if (start < 0) return null;
  const end = lower.lastIndexOf('</html>');
  if (end < 0) return { html: t.slice(start), complete: false };
  return { html: t.slice(start, end + 7), complete: true };
}

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

export function validateHtml(html: string, maxBytes: number): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const lower = html.toLowerCase();
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > maxBytes) errors.push(`Page is too large (${Math.round(bytes / 1024)} KB).`);
  if (!lower.includes('<!doctype html')) errors.push('Missing <!DOCTYPE html>.');
  for (const tag of ['<html', '<head', '<body', '</body>', '</html>']) {
    if (!lower.includes(tag)) errors.push(`Missing ${tag}.`);
  }
  if (!/<title[^>]*>\s*\S[^<]*<\/title>/i.test(html)) errors.push('Missing a non-empty <title>.');
  if (!/<h1[\s>]/i.test(html)) errors.push('Missing an <h1> heading.');
  if (count(html, /<style\b/gi) !== count(html, /<\/style>/gi)) errors.push('Unbalanced <style> tags.');
  if (count(html, /<script\b/gi) !== count(html, /<\/script>/gi)) errors.push('Unbalanced <script> tags.');
  if (/lorem ipsum/i.test(html)) errors.push('Contains placeholder lorem ipsum text.');
  // Content slop that makes a page look unfinished. Kept narrow to avoid false repairs.
  if (/\byour (?:tagline|headline|slogan|text) here\b|\[placeholder\]|\binsert (?:your|a) [^<]{0,30}?here\b|\breplace this text\b|\bfeature [123]\b/i.test(html)) {
    errors.push('Contains placeholder copy ("Feature 1", "your text here", etc.) instead of real content.');
  }
  if (/<section\b[^>]*>\s*<\/section>/i.test(html)) errors.push('Contains an empty <section>.');
  return { ok: errors.length === 0, errors };
}

/** Remove constructs that could hijack navigation or break relative asset URLs. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
}

export interface MobileCheck { name: string; ok: boolean }

/** Static mobile-readiness lint. This does not render the page; it looks for known-good signals and known hazards. */
export function mobileReport(html: string): MobileCheck[] {
  const hasViewport = /<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i.test(html);
  const responsive = /@media|clamp\(|minmax\(|auto-fit|auto-fill|flex-wrap/i.test(html);
  const wide = [...html.matchAll(/(?<![\w-])(?:min-)?width\s*:\s*(\d{3,4})px/gi)].some((m) => Number(m[1]) > 480);
  const imgNoAlt = /<img\b(?![^>]*\balt\s*=)[^>]*>/i.test(html);
  return [
    { name: 'Viewport meta tag', ok: hasViewport },
    { name: 'Responsive CSS (media queries / fluid units)', ok: responsive },
    { name: 'No fixed-width elements wider than a phone', ok: !wide },
    { name: 'Images have alt text', ok: !imgNoAlt },
  ];
}

const SAFETY_CSS =
  '<style id="nl-safety">*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}' +
  'img,video,svg,canvas{max-width:100%;height:auto}body{overflow-wrap:anywhere}</style>';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** Adds a viewport tag if absent and a low-specificity safety net placed first in <head> so author CSS wins. */
export function applyMobileSafety(html: string): string {
  const hasViewport = /<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i.test(html);
  const inject = (hasViewport ? '' : VIEWPORT) + SAFETY_CSS;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + inject);
  return html.replace(/<html\b[^>]*>/i, (m) => m + '<head>' + inject + '</head>');
}
