import type { Env } from '../env.ts';
import { AppError } from '../http.ts';
import type { R2Like } from '../types.ts';
import { oidcRoleCredentials, staticCredentials } from './creds.ts';
import type { CredentialProvider } from './creds.ts';
import { createS3Storage } from './s3.ts';
import type { Storage } from './types.ts';

export function createR2Storage(bucket: R2Like): Storage {
  return {
    async put(key, body, opts) {
      await bucket.put(key, body, { httpMetadata: { contentType: opts.contentType, cacheControl: opts.cacheControl } });
    },
    async get(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      return { body: await o.arrayBuffer(), contentType: o.httpMetadata?.contentType ?? 'application/octet-stream', size: o.size };
    },
    async head(key) {
      const o = await bucket.head(key);
      return o ? { size: o.size, contentType: o.httpMetadata?.contentType } : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async copy(src, dst) {
      const o = await bucket.get(src);
      if (!o) throw new AppError('storage_error', 'Source object missing during copy.', 502);
      await bucket.put(dst, await o.arrayBuffer(), { httpMetadata: { contentType: o.httpMetadata?.contentType } });
    },
  };
}

export interface StorageDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function credentialProvider(env: Env, origin: string, d: StorageDeps): CredentialProvider {
  if (env.AWS_ROLE_ARN && env.OIDC_PRIVATE_KEY) {
    return oidcRoleCredentials({
      issuer: origin, roleArn: env.AWS_ROLE_ARN, region: env.AWS_REGION ?? 'us-east-1',
      privateKeyPem: env.OIDC_PRIVATE_KEY, kid: env.OIDC_KID ?? 'netlaunch-1', fetch: d.fetch, now: d.now,
    });
  }
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return staticCredentials(env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY);
  throw new AppError('not_configured', 'AWS credentials are not configured (set AWS_ROLE_ARN + OIDC_PRIVATE_KEY, or access keys).', 500);
}

/** Credential providers hold a cache; keep one per isolate so STS is not called on every request. */
const credCache = new Map<string, CredentialProvider>();

export function createStorage(env: Env, origin: string, d: StorageDeps): Storage {
  const driver = (env.STORAGE_DRIVER ?? 's3').toLowerCase();
  if (driver === 'r2') {
    if (!env.BUCKET) throw new AppError('not_configured', 'STORAGE_DRIVER=r2 but no R2 bucket binding named BUCKET.', 500);
    return createR2Storage(env.BUCKET);
  }
  if (!env.S3_BUCKET) throw new AppError('not_configured', 'S3_BUCKET is not set.', 500);
  const cacheKey = `${origin}|${env.AWS_ROLE_ARN ?? ''}|${env.AWS_ACCESS_KEY_ID ?? ''}`;
  let creds = credCache.get(cacheKey);
  if (!creds) {
    creds = credentialProvider(env, origin, d);
    credCache.set(cacheKey, creds);
  }
  return createS3Storage({ bucket: env.S3_BUCKET, region: env.AWS_REGION ?? 'us-east-1', creds, fetch: d.fetch, sleep: d.sleep });
}
