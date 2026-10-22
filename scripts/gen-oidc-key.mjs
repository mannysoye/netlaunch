// Generates the RSA key the Worker uses to sign its OIDC tokens for AWS (IAM role via web identity).
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const file = 'oidc-private-key.pem';
if (existsSync(file)) { console.error(`${file} already exists. Delete it first if you really want a new key.`); process.exit(1); }
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
writeFileSync(file, privateKey, { mode: 0o600 });
console.log(`Wrote ${file} (git-ignored). Next:

  npx wrangler secret put OIDC_PRIVATE_KEY < ${file}

Then store the file in your password manager and delete it from disk.
The public half is derived automatically and served at /.well-known/jwks.json.`);
