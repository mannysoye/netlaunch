/** The brief is the single source of truth for a site. The LLM proposes updates; this module validates them. */

export interface Brief {
  idea?: string;
  business?: string;
  audience?: string;
  tone?: string;
  palette?: string;
  language?: string;
  contact?: string;
  notes?: string;
  sections?: string[];
  features?: string[];
  pageName?: string; // validated slug, set by the app (never by the LLM)
  ready?: boolean; // enough info gathered; structure proposed
  structure?: string; // layout summary shown to the user for confirmation
  suggestedName?: string;
  pendingRevision?: string; // accumulated change requests for a live site
  revisions?: string[]; // applied change requests (kept so regenerations stay consistent)
}

const TEXT_FIELDS = ['business', 'audience', 'tone', 'palette', 'language', 'contact', 'notes'] as const;
const LIST_FIELDS = ['sections', 'features'] as const;

const clip = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return s || undefined;
};

export function parseBrief(raw: string | null | undefined): Brief {
  try {
    const o = JSON.parse(raw || '{}');
    return o && typeof o === 'object' ? (o as Brief) : {};
  } catch {
    return {};
  }
}

/** Apply untrusted updates from the model onto the brief. Unknown keys are ignored. */
export function mergeBrief(brief: Brief, updates: unknown): Brief {
  const next: Brief = { ...brief };
  if (!updates || typeof updates !== 'object') return next;
  const u = updates as Record<string, unknown>;
  for (const k of TEXT_FIELDS) {
    const v = clip(u[k], k === 'notes' ? 600 : 200);
    if (v) next[k] = v;
  }
  for (const k of LIST_FIELDS) {
    if (Array.isArray(u[k])) {
      const list = (u[k] as unknown[]).map((x) => clip(x, 80)).filter((x): x is string => !!x).slice(0, 12);
      if (list.length) next[k] = list;
    }
  }
  return next;
}

export interface Choice { label: string }
export interface PlannerResult {
  reply: string;
  choices: Choice[];
  brief: unknown;
  ready: boolean;
  structure: string | null;
  suggestedName: string | null;
}

/** Defensive normalisation of whatever JSON the model returned. */
export function normalizePlanner(o: unknown): PlannerResult | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const reply = clip(r.reply, 700);
  if (!reply) return null;
  const choices = Array.isArray(r.choices)
    ? r.choices
        .map((c) => clip(typeof c === 'string' ? c : (c as { label?: unknown })?.label, 40))
        .filter((l): l is string => !!l)
        .slice(0, 5)
        .map((label) => ({ label }))
    : [];
  const structureRaw = typeof r.structure === 'string' ? r.structure.trim().slice(0, 1500) : '';
  return {
    reply: typeof r.reply === 'string' ? r.reply.trim().slice(0, 700) : reply,
    choices,
    brief: r.brief,
    ready: r.ready === true,
    structure: structureRaw || null,
    suggestedName: clip(r.suggestedName, 60) ?? null,
  };
}

/** Lenient JSON extraction: handles code fences and prose around a single JSON object. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch { /* try to find the outermost object */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch { /* give up */ }
  }
  return null;
}

export interface ImageInfo { filename: string; role: string; caption: string | null }

export function briefForPrompt(brief: Brief, images: ImageInfo[]): string {
  const { ready: _r, structure: _s, suggestedName: _n, pendingRevision: _p, ...rest } = brief;
  const imgs = images.map((i) => `assets/${i.filename} (${i.role}${i.caption ? ': ' + i.caption : ''})`);
  return JSON.stringify({ ...rest, images: imgs });
}
