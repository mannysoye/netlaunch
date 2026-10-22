import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signV4 } from '../worker/storage/sigv4.ts';
import { checkSlug, normalizeSlug, looksLikeSlug } from '../worker/domain/slug.ts';
import { extractHtml, validateHtml, sanitizeHtml, mobileReport, applyMobileSafety } from '../worker/domain/html.ts';
import { mergeBrief, normalizePlanner, parseJsonLoose } from '../worker/domain/brief.ts';
import { importSigningKey, mintJwt, publicJwk, oidcRoleCredentials } from '../worker/storage/creds.ts';

test('SigV4 matches the AWS S3 documentation example (GET Object with Range)', async () => {
  const h = await signV4({
    method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { Range: 'bytes=0-9' },
    creds: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(h.authorization!, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('SigV4 with query string matches AWS example (GET ?lifecycle)', async () => {
  const h = await signV4({
    method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle',
    creds: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(h.authorization!, /Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543$/);
});

test('slugs', () => {
  assert.equal(normalizeSlug('  Café  Délice & Co! '), 'cafe-delice-and-co');
  assert.equal(checkSlug('ab').ok, false);
  assert.equal(checkSlug('api').ok, false);
  assert.equal(checkSlug('paypal-login').ok, false);
  assert.equal(checkSlug('x'.repeat(41)).ok, false);
  assert.deepEqual(checkSlug('My Bakery'), { ok: true, slug: 'my-bakery' });
  assert.equal(looksLikeSlug('my-bakery'), true);
  assert.equal(looksLikeSlug('assets'), false);
  assert.equal(looksLikeSlug('-bad'), false);
});

const GOOD = '<!DOCTYPE html><html><head><title>Hi</title><style>a{}</style></head><body><h1>Hi</h1><script>1</script></body></html>';
test('html extraction/validation', () => {
  assert.equal(extractHtml('```html\n' + GOOD + '\n```')!.html, GOOD);
  assert.equal(extractHtml('Sure! here:\n' + GOOD + '\nEnjoy')!.complete, true);
  assert.equal(extractHtml(JSON.stringify({ html: GOOD }))!.html, GOOD);
  assert.equal(extractHtml('<!DOCTYPE html><html><body><h1>cut')!.complete, false);
  assert.equal(extractHtml('no html here'), null);
  assert.equal(validateHtml(GOOD, 10_000).ok, true);
  assert.equal(validateHtml(GOOD.replace('</style>', ''), 10_000).ok, false);
  assert.equal(validateHtml(GOOD, 50).ok, false);
  assert.equal(validateHtml(GOOD.replace('<h1>Hi</h1>', '<p>lorem ipsum</p>'), 10_000).ok, false);
  assert.equal(validateHtml(GOOD.replace('<h1>Hi</h1>', '<h1>Feature 1</h1>'), 10_000).ok, false);
  assert.equal(validateHtml(GOOD.replace('<h1>Hi</h1>', '<h1>Your tagline here</h1>'), 10_000).ok, false);
  assert.equal(validateHtml(GOOD.replace('<h1>Hi</h1>', '<section></section><h1>Hi</h1>'), 10_000).ok, false);
  // A real form field must not be mistaken for placeholder copy.
  assert.equal(validateHtml(GOOD.replace('<h1>Hi</h1>', '<h1>Order</h1><input placeholder="Your name">'), 10_000).ok, true);
});
test('sanitize + mobile', () => {
  assert.equal(sanitizeHtml('<head><base href="//evil/"><meta http-equiv="refresh" content="0;url=//x"></head>'), '<head></head>');
  const r = mobileReport('<html><head><style>.a{width:900px}</style></head><img src=x></html>');
  assert.equal(r.filter((c) => !c.ok).length, 4);
  const fixed = applyMobileSafety(GOOD);
  assert.ok(fixed.includes('name="viewport"') && fixed.includes('nl-safety'));
  assert.equal(mobileReport(fixed).find((c) => c.name.startsWith('Viewport'))!.ok, true);
  assert.equal(applyMobileSafety(fixed).split('name="viewport"').length, 2); // idempotent on viewport
});
test('brief merge ignores junk and clamps', () => {
  const b = mergeBrief({ idea: 'x' }, { business: ' Bakery  ', hack: 1, sections: ['a', 5, 'b'], tone: 7, pageName: 'evil' });
  assert.deepEqual(b, { idea: 'x', business: 'Bakery', sections: ['a', 'b'] });
  assert.equal(normalizePlanner({ reply: '' }), null);
  assert.equal(normalizePlanner({ reply: 'hi', choices: ['a', { label: 'b' }, 3], ready: 'yes' })!.ready, false);
  assert.deepEqual(parseJsonLoose('Here: {"a":1} thanks'), { a: 1 });
  assert.equal(parseJsonLoose('nope'), null);
});

test('OIDC: JWT verifies against the published JWKS; STS flow caches credentials', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;
  const jwk = await publicJwk(pem, 'k1');
  assert.equal(jwk.kid, 'k1');
  assert.ok(!('d' in jwk));
  const key = await importSigningKey(pem);
  const jwt = await mintJwt({ key, kid: 'k1', issuer: 'https://netpins.xyz', audience: 'sts.amazonaws.com', subject: 's', nowSec: 1000 });
  const [h, p, s] = jwt.split('.');
  const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, Buffer.from(s!, 'base64url'), new TextEncoder().encode(`${h}.${p}`));
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(Buffer.from(p!, 'base64url').toString()), { iss: 'https://netpins.xyz', sub: 's', aud: 'sts.amazonaws.com', iat: 1000, exp: 1300 });

  let calls = 0; let sentToken = '';
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    calls++; sentToken = (init.body as URLSearchParams).get('WebIdentityToken')!;
    return new Response('<R><AccessKeyId>AKIA1</AccessKeyId><SecretAccessKey>sec</SecretAccessKey><SessionToken>tok</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></R>');
  }) as unknown as typeof fetch;
  const prov = oidcRoleCredentials({ issuer: 'https://netpins.xyz', roleArn: 'arn:aws:iam::1:role/r', region: 'us-east-1', privateKeyPem: pem, kid: 'k1', fetch: fakeFetch, now: () => 1_000_000 });
  const [c1, c2] = await Promise.all([prov.get(), prov.get()]);
  assert.equal(c1.sessionToken, 'tok'); assert.equal(c2.accessKeyId, 'AKIA1');
  assert.equal(calls, 1); // concurrent callers share one STS call
  await prov.get(); assert.equal(calls, 1); // cached
  assert.equal(sentToken.split('.').length, 3);
  const bad = oidcRoleCredentials({ issuer: 'x', roleArn: 'r', region: 'us-east-1', privateKeyPem: pem, kid: 'k', now: () => 0,
    fetch: (async () => new Response('<Error><Code>InvalidIdentityToken</Code><Message>no jwks</Message></Error>', { status: 400 })) as unknown as typeof fetch });
  await assert.rejects(bad.get(), /InvalidIdentityToken/);
});
