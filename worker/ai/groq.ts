import { AppError } from '../http.ts';

const BASE = 'https://api.groq.com/openai/v1';
const MAX_WAIT_S = 45; // longer than this and waiting inside a request is pointless

export interface GroqDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  apiKey: string | undefined;
}

export interface ChatParams {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  json?: boolean;
}
export interface ChatResult { text: string; finishReason: string }
export interface Hooks { onWait?: (seconds: number) => void }

/** Groq says things like "Please try again in 7.66s" or "1m2.5s". */
export function parseWaitSeconds(res: Response, body: string): number | null {
  const h = Number(res.headers.get('retry-after'));
  if (Number.isFinite(h) && h > 0) return h;
  const m = body.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (!m) return null;
  const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return s > 0 ? s : null;
}

function mapStatus(status: number, detail: string): AppError {
  console.error(JSON.stringify({ level: 'error', where: 'groq', status, detail: detail.slice(0, 300) }));
  if (status === 401 || status === 403) return new AppError('ai_unavailable', 'The AI service rejected our credentials. The site owner needs to check the Groq API key.', 502);
  if (status === 413) return new AppError('ai_bad_output', 'That request was too big for the AI. Try a shorter description.', 413);
  if (status === 429) return new AppError('ai_rate_limited', 'The AI is at capacity right now. Please try again in a minute.', 429, true);
  if (status >= 500) return new AppError('ai_unavailable', 'The AI service is having trouble. Please try again.', 502, true);
  return new AppError('ai_unavailable', 'The AI could not process that request.', 502);
}

async function sendWithRetry(d: GroqDeps, make: () => Promise<Response>, hooks?: Hooks): Promise<Response> {
  if (!d.apiKey) throw new AppError('not_configured', 'GROQ_API_KEY is not set on the server.', 500);
  let last: AppError | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await make();
    } catch {
      last = new AppError('ai_unavailable', 'Could not reach the AI service. Please try again.', 502, true);
      if (attempt < 3) { await d.sleep(500 * attempt); continue; }
      throw last;
    }
    if (res.ok) return res;
    const body = await res.clone().text().catch(() => '');
    if (res.status === 429) {
      const wait = parseWaitSeconds(res, body);
      last = mapStatus(429, body);
      if (wait === null || wait > MAX_WAIT_S || attempt === 3) throw wait && wait > MAX_WAIT_S
        ? new AppError('ai_rate_limited', 'We’ve hit the AI’s usage limit for now. Please try again later.', 429, false) : last;
      hooks?.onWait?.(Math.ceil(wait));
      await d.sleep(Math.ceil(wait * 1000) + 250);
      continue;
    }
    if (res.status >= 500 && attempt < 3) { last = mapStatus(res.status, body); await d.sleep(800 * attempt); continue; }
    return res; // caller handles 4xx
  }
  throw last ?? new AppError('ai_unavailable', 'The AI service is unavailable.', 502, true);
}

export async function groqChat(d: GroqDeps, p: ChatParams, hooks?: Hooks): Promise<ChatResult> {
  const build = (withOptional: boolean) => {
    const body: Record<string, unknown> = {
      model: p.model, messages: p.messages, max_completion_tokens: p.maxTokens, temperature: p.temperature ?? 0.6, stream: false,
    };
    if (withOptional) {
      if (p.json) body.response_format = { type: 'json_object' };
      if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;
    }
    return () => d.fetch(`${BASE}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${d.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  };

  let res = await sendWithRetry(d, build(true), hooks);
  if (res.status === 400) {
    // Some model/param combinations are rejected. Retry once without the optional knobs.
    const detail = await res.text().catch(() => '');
    if (/response_format|reasoning|json/i.test(detail)) res = await sendWithRetry(d, build(false), hooks);
    else throw mapStatus(400, detail);
  }
  if (!res.ok) throw mapStatus(res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  const choice = data.choices?.[0];
  return { text: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? 'unknown' };
}

const AUDIO_EXT: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
};
export const audioExt = (mime: string): string | null => AUDIO_EXT[mime.split(';')[0]!.trim().toLowerCase()] ?? null;

export async function groqTranscribe(d: GroqDeps, p: { model: string; audio: Blob; mime: string; language?: string }): Promise<string> {
  const ext = audioExt(p.mime);
  if (!ext) throw new AppError('unsupported_media', 'That audio format isn’t supported.', 415);
  const make = () => {
    const form = new FormData();
    form.append('file', p.audio, `memo.${ext}`);
    form.append('model', p.model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (p.language) form.append('language', p.language);
    return d.fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${d.apiKey}` }, body: form, signal: AbortSignal.timeout(90_000) });
  };
  const res = await sendWithRetry(d, make);
  if (!res.ok) throw mapStatus(res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
