import { AppError, b64url } from '../http.ts';
import type { AwsCreds } from './sigv4.ts';

export interface CredentialProvider {
  get(): Promise<AwsCreds>;
  mode: 'static' | 'oidc-role';
}

export function staticCredentials(accessKeyId: string, secretAccessKey: string): CredentialProvider {
  return { mode: 'static', get: async () => ({ accessKeyId, secretAccessKey }) };
}

/* ---------- OIDC: the Worker is its own identity provider ----------
 * AWS cannot attach an IAM role to a Cloudflare Worker, so instead the Worker signs a short-lived JWT with
 * a private key it owns, AWS verifies it against the public key served at /.well-known/jwks.json, and
 * STS hands back temporary credentials for an IAM *role* (AssumeRoleWithWebIdentity). No long-lived AWS keys.
 */

const enc = new TextEncoder();

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function importSigningKey(pem: string, extractable = false): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      pemToDer(pem) as BufferSource,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      extractable,
      ['sign'],
    );
  } catch {
    throw new AppError('not_configured', 'OIDC_PRIVATE_KEY is not a valid PKCS#8 RSA private key (run `npm run oidc:keygen`).', 500);
  }
}

export interface Jwk { kty: 'RSA'; n: string; e: string; alg: 'RS256'; use: 'sig'; kid: string }

export async function publicJwk(pem: string, kid: string): Promise<Jwk> {
  const key = await importSigningKey(pem, true);
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as { n: string; e: string };
  return { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid };
}

export async function mintJwt(p: {
  key: CryptoKey; kid: string; issuer: string; audience: string; subject: string; nowSec: number; ttlSec?: number;
}): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid: p.kid };
  const payload = { iss: p.issuer, sub: p.subject, aud: p.audience, iat: p.nowSec, exp: p.nowSec + (p.ttlSec ?? 300) };
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', p.key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

const xml = (s: string, tag: string): string | undefined => s.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

export interface OidcOptions {
  issuer: string; // https://netpins.xyz  (must equal the IAM OIDC provider URL)
  roleArn: string;
  region: string;
  privateKeyPem: string;
  kid: string;
  fetch: typeof fetch;
  now: () => number;
}

export function oidcRoleCredentials(o: OidcOptions): CredentialProvider {
  let cached: { creds: AwsCreds; expiresAt: number } | null = null;
  let inflight: Promise<AwsCreds> | null = null;
  let key: CryptoKey | null = null;

  async function refresh(): Promise<AwsCreds> {
    key ??= await importSigningKey(o.privateKeyPem);
    const token = await mintJwt({
      key, kid: o.kid, issuer: o.issuer, audience: 'sts.amazonaws.com', subject: 'netlaunch-worker', nowSec: Math.floor(o.now() / 1000),
    });
    const body = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: o.roleArn,
      RoleSessionName: 'netlaunch-worker',
      WebIdentityToken: token,
      DurationSeconds: '3600',
    });
    let res: Response;
    try {
      res = await o.fetch(`https://sts.${o.region}.amazonaws.com/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (e) {
      throw new AppError('storage_error', 'Could not reach AWS STS.', 502, true);
    }
    const text = await res.text();
    if (!res.ok) {
      const code = xml(text, 'Code') ?? String(res.status);
      const msg = xml(text, 'Message') ?? '';
      console.error(JSON.stringify({ level: 'error', where: 'sts', code, msg }));
      throw new AppError('storage_error', `AWS rejected the role assumption (${code}). ${msg}`.trim(), 502, code === 'ExpiredTokenException');
    }
    const accessKeyId = xml(text, 'AccessKeyId');
    const secretAccessKey = xml(text, 'SecretAccessKey');
    const sessionToken = xml(text, 'SessionToken');
    const expiration = xml(text, 'Expiration');
    if (!accessKeyId || !secretAccessKey || !sessionToken) throw new AppError('storage_error', 'AWS STS returned an unexpected response.', 502, true);
    const creds = { accessKeyId, secretAccessKey, sessionToken };
    cached = { creds, expiresAt: expiration ? Date.parse(expiration) : o.now() + 3_300_000 };
    return creds;
  }

  return {
    mode: 'oidc-role',
    async get() {
      if (cached && cached.expiresAt - o.now() > 5 * 60_000) return cached.creds;
      inflight ??= refresh().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
