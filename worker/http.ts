export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'limit_guest_projects' | 'limit_projects' | 'rate_limited' | 'quota_exceeded'
  | 'ai_unavailable' | 'ai_rate_limited' | 'ai_bad_output' | 'storage_error'
  | 'slug_taken' | 'slug_invalid' | 'payload_too_large' | 'unsupported_media'
  | 'not_configured' | 'internal';

/** An error whose message is safe to show to the person using the app. */
export class AppError extends Error {
  code: ErrorCode;
  status: number;
  retryable: boolean;
  constructor(code: ErrorCode, message: string, status = 400, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

export async function readJson<T>(req: Request, maxBytes = 64_000): Promise<T> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new AppError('payload_too_large', 'That request is too large.', 413);
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError('payload_too_large', 'That request is too large.', 413);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError('bad_request', 'The request body was not valid JSON.', 400);
  }
}

export function errorBody(e: unknown, requestId: string) {
  if (e instanceof AppError) {
    return { status: e.status, body: { error: { code: e.code, message: e.message, retryable: e.retryable, requestId } } };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'internal' as const,
        message: 'Something went wrong on our side. Please try again in a moment.',
        retryable: true,
        requestId,
      },
    },
  };
}

export function errorResponse(e: unknown, requestId: string): Response {
  const { status, body } = errorBody(e, requestId);
  if (!(e instanceof AppError) || e.status >= 500) {
    // Structured log, visible in Workers Logs. Never include secrets here.
    const err = e as Error;
    console.error(JSON.stringify({ level: 'error', requestId, name: err?.name, message: err?.message, stack: err?.stack?.split('\n').slice(0, 4) }));
  }
  return json(body, status);
}

export const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
