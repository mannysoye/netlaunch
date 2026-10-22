export class ApiError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  constructor(code: string, message: string, status = 0, retryable = false) {
    super(message);
    this.code = code; this.status = status; this.retryable = retryable;
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const j = (await res.json()) as { error?: { code: string; message: string; retryable?: boolean } };
    if (j.error) return new ApiError(j.error.code, j.error.message, res.status, !!j.error.retryable);
  } catch { /* not JSON */ }
  return new ApiError('http_' + res.status, 'Something went wrong. Please try again.', res.status, res.status >= 500);
}

const offlineError = () => new ApiError('network', 'You seem to be offline. Check your connection and try again.', 0, true);

export async function api<T>(path: string, init: { method?: string; json?: unknown; body?: BodyInit } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.json !== undefined || init.body ? 'POST' : 'GET'),
      headers: init.json !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      credentials: 'same-origin',
    });
  } catch { throw offlineError(); }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export interface SseEvent { event: string; data: any }

/** POST + read a text/event-stream (EventSource can't POST). */
export async function* sse(path: string, json: unknown): AsyncGenerator<SseEvent> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json ?? {}), credentials: 'same-origin' });
  } catch { throw offlineError(); }
  if (!res.ok || !res.body) throw await toError(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev && data) yield { event: ev, data: JSON.parse(data) };
    }
  }
}

/** Auth.js sign-in/out are CSRF-protected POST forms. */
export async function authPost(action: 'signin' | 'signout', provider?: string): Promise<void> {
  const { csrfToken } = (await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()) as { csrfToken: string };
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action === 'signin' ? `/api/auth/signin/${provider}` : '/api/auth/signout';
  for (const [k, v] of Object.entries({ csrfToken, callbackUrl: location.origin + '/' })) {
    const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.append(i);
  }
  document.body.append(form);
  form.submit();
}
