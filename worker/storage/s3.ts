import { AppError } from '../http.ts';
import type { CredentialProvider } from './creds.ts';
import { signV4 } from './sigv4.ts';
import type { PutOptions, Storage, StoredObject } from './types.ts';

export interface S3Options {
  bucket: string;
  region: string;
  creds: CredentialProvider;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');
const s3Code = (xml: string): string => xml.match(/<Code>([^<]*)<\/Code>/)?.[1] ?? '';

export function createS3Storage(o: S3Options): Storage {
  // Virtual-hosted style unless the bucket name contains dots (breaks the TLS wildcard).
  const base = o.bucket.includes('.')
    ? `https://s3.${o.region}.amazonaws.com/${o.bucket}`
    : `https://${o.bucket}.s3.${o.region}.amazonaws.com`;

  /** Signed request with retries on network errors, 5xx and throttling. */
  async function call(method: string, key: string, init: { headers?: Record<string, string>; body?: Uint8Array | string } = {}): Promise<Response> {
    const url = `${base}/${encodeKey(key)}`;
    let lastErr = 'unknown';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const creds = await o.creds.get();
        const headers = await signV4({ method, url, headers: init.headers, body: init.body, creds, region: o.region, date: o.now ? new Date(o.now()) : undefined });
        const res = await o.fetch(url, { method, headers, body: init.body as BodyInit | undefined });
        if (res.status < 500 && res.status !== 429) return res;
        lastErr = `HTTP ${res.status}`;
      } catch (e) {
        if (e instanceof AppError && !e.retryable) throw e;
        lastErr = e instanceof AppError ? e.message : 'network error';
      }
      if (attempt < 3) await o.sleep(300 * 2 ** (attempt - 1));
    }
    throw new AppError('storage_error', `Storage is temporarily unavailable (${lastErr}).`, 502, true);
  }

  async function fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = s3Code(text) || String(res.status);
    console.error(JSON.stringify({ level: 'error', where: 's3', op: what, status: res.status, code }));
    const hint = res.status === 403 ? ' (check the IAM role/user permissions and bucket name)' : '';
    throw new AppError('storage_error', `Storage ${what} failed: ${code}${hint}`, 502, res.status >= 500);
  }

  return {
    async put(key: string, body: Uint8Array | string, opts: PutOptions) {
      const headers: Record<string, string> = { 'content-type': opts.contentType };
      if (opts.cacheControl) headers['cache-control'] = opts.cacheControl;
      const res = await call('PUT', key, { headers, body });
      if (!res.ok) await fail(res, 'upload');
    },
    async get(key: string): Promise<StoredObject | null> {
      const res = await call('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, 'read');
      const body = await res.arrayBuffer();
      return { body, contentType: res.headers.get('content-type') ?? 'application/octet-stream', size: body.byteLength };
    },
    async head(key: string) {
      const res = await call('HEAD', key);
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, 'check');
      return { size: Number(res.headers.get('content-length') ?? 0), contentType: res.headers.get('content-type') ?? undefined };
    },
    async delete(key: string) {
      const res = await call('DELETE', key);
      if (!res.ok && res.status !== 404) await fail(res, 'delete');
    },
    async copy(srcKey: string, dstKey: string) {
      const res = await call('PUT', dstKey, { headers: { 'x-amz-copy-source': `/${o.bucket}/${encodeKey(srcKey)}` } });
      const text = await res.text();
      // S3 can return HTTP 200 with an <Error> body for copies.
      if (!res.ok || text.includes('<Error>')) {
        console.error(JSON.stringify({ level: 'error', where: 's3', op: 'copy', status: res.status, code: s3Code(text) }));
        throw new AppError('storage_error', `Storage copy failed: ${s3Code(text) || res.status}`, 502, res.status >= 500);
      }
    },
  };
}
