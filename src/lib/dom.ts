export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);

/** Tiny, safe markdown: escape first, then allow **bold**, `code`, "- " bullets and line breaks. */
export function md(text: string): string {
  const lines = esc(text).split('\n');
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const bullet = /^\s*[-•]\s+(.*)$/.exec(line);
    if (bullet) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${bullet[1]}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(line.trim() === '' ? '<div class="h-2"></div>' : `<p>${line}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

export const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
