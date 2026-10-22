# NetLaunch

Describe a website by **typing or talking**. NetLaunch asks a few smart questions, proposes a layout, builds the site with AI, and publishes it at `yourdomain/name` (e.g. `netpins.xyz/sunrise-bakery`). Every site can be downloaded as a `.zip`.

- **Flow:** prompt → clarifying questions + design choices + page name → layout confirmation → build & deploy → link + download icon in chat
- **Voice memos:** record up to 5 minutes, transcribed by Groq Whisper, pasted into the chat box for you to edit and send
- **Chat history** in a sidebar, **PWA** (installable, works offline for the app shell), **guest mode** (1 project) with GitHub/Google sign-in for more
- **Stack:** Cloudflare Worker + static assets · D1 (database) · S3 (site files) via an IAM **role** · Groq `openai/gpt-oss-120b` · Auth.js · Tailwind CSS v4 · Vite · TypeScript

> **Security first.** If you ever pushed the old `main.py`, `start.sh` or `netlaunch.pem` anywhere, treat them as compromised: **revoke the old Gemini API key and delete/rotate the EC2 key pair now**. They are not part of this project and `.gitignore` blocks `*.pem`, `.env*` and `.dev.vars`.

---

## 1. How it works

```
Browser (PWA)  ──►  Cloudflare Worker  ──►  Groq  (chat: gpt-oss-120b, speech-to-text: Whisper)
 Tailwind UI         • /api/*  (tiny built-in router)   
 voice recorder      • Auth.js at /api/auth/*  ──►  D1 (projects, chat history, quotas)
 zip download        • serves published sites         
                     │                                
                     └─► S3 (private bucket) via short-lived IAM-role credentials
                         sites/<name>/index.html, sites/<name>/assets/*
```

- The static app (`dist/`) is served by Cloudflare's asset layer (free, unlimited). The Worker only runs for API calls and for published pages.
- A request for `netpins.xyz/<name>/` isn't a file in `dist/`, so it falls through to the Worker, which reads `sites/<name>/index.html` from S3 and serves it with a **sandbox CSP** (see Security).
- **IAM role without AWS-hosted compute:** Workers can't have a role attached. Instead the Worker acts as its own OIDC identity provider: it signs a 5-minute JWT, AWS verifies it against `https://yourdomain/.well-known/jwks.json`, and STS returns **1-hour role credentials**. There are no long-lived AWS keys anywhere. (Access keys are supported as a fallback.)

### Where things live

| Path | What |
| --- | --- |
| `worker/` | Backend (TypeScript). `app.ts` router · `flow.ts` conversation state machine · `routes/` · `ai/` (Groq) · `storage/` (S3 SigV4, OIDC credentials, R2) · `domain/` (pure logic) |
| `src/` | Frontend (TypeScript + Tailwind). `ui/views.ts` pure render functions · `main.ts` actions · `lib/recorder.ts` voice memos |
| `migrations/` | D1 schema |
| `public/` | PWA manifest, service worker, icons, security headers |
| `aws/` | `setup.sh` (bucket + role), `budget.sh` (billing alarm) |
| `test/` | 15 tests that run the **entire Worker** in Node against a real SQLite DB and mocked Groq/S3/STS |

---

## 2. What you need installed

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | **22.12+** (22 LTS) | build, tests, Wrangler |
| npm | 10+ | comes with Node |
| Git | any | deploy via Git |
| AWS CLI | v2 | `aws/setup.sh` (one-time) |
| `openssl` | any | generate `AUTH_SECRET` |

Accounts: **Cloudflare** (free), **AWS**, **Groq** (free key at console.groq.com), and a **GitHub and/or Google** OAuth app (optional; guests work without them).

---

## 3. Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars       # then fill it in (see below)
npm run db:migrate:local             # creates the local D1 database
npm run dev:full                     # builds the UI and starts the Worker at http://localhost:8787
```

Minimum for a first local run: `GROQ_API_KEY` and `AUTH_SECRET` (`openssl rand -base64 33`). For storage pick one:

- **Easiest (no AWS):** in `wrangler.jsonc` set `"STORAGE_DRIVER": "r2"` and add the commented `r2_buckets` block. Wrangler emulates R2 locally.
- **Real S3:** put `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `.dev.vars` and set `S3_BUCKET`, `AWS_REGION` (and remove `AWS_ROLE_ARN`).

For UI hot-reload run `npm run dev:api` in one terminal and `npm run dev` in another (Vite proxies `/api` to the Worker).

Useful commands: `npm test` · `npm run typecheck` · `npm run build` · `npm run icons`

**Your logo:** save it as `public/logo-source.png` (square, ≥512px), run `npm run icons`, commit the generated `public/icons/*`. To retheme, edit the colour tokens at the top of `src/styles.css`.

---

## 4. Deploy (Cloudflare + Git)

### 4.1 One-time Cloudflare setup

1. Add `netpins.xyz` to Cloudflare (nameservers). **Delete the old DNS records** that pointed the apex/wildcard at EC2 or S3. The Worker's custom domain creates its own record, and wildcard subdomains are no longer used.
2. `npx wrangler login`
3. Create the database and paste the printed `database_id` into `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create netlaunch
   npm run db:migrate:remote
   ```
4. Set secrets (each prompts for the value):
   ```bash
   npx wrangler secret put GROQ_API_KEY
   npx wrangler secret put AUTH_SECRET            # openssl rand -base64 33
   npx wrangler secret put ADMIN_TOKEN            # any long random string; unlocks the health check
   npx wrangler secret put AUTH_GITHUB_ID         # optional
   npx wrangler secret put AUTH_GITHUB_SECRET
   npx wrangler secret put AUTH_GOOGLE_ID         # optional
   npx wrangler secret put AUTH_GOOGLE_SECRET
   ```
5. Edit the `vars` in `wrangler.jsonc`: `PUBLIC_ORIGIN`, `S3_BUCKET`, `AWS_REGION`, and the `routes` pattern if your domain differs.

### 4.2 Connect Git (auto-deploy on every push)

Push this repo to GitHub, then in the Cloudflare dashboard: **Workers & Pages → Create → Import a repository** (Workers Builds).

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Node version | 22 (add build variable `NODE_VERSION=22`) |

Every push to `main` now builds and deploys. `.github/workflows/ci.yml` also runs typecheck + tests on every push and PR. When you change `migrations/`, run `npm run db:migrate:remote` before deploying.

> Cloudflare is steering new projects to Workers + Static Assets rather than classic "Pages". It is the same free plan, Git integration and custom domains; this repo uses that model.

### 4.3 OAuth apps (for sign-in)

Callback URLs to register (add `http://localhost:8787/...` too for local testing):

- **GitHub** (Settings → Developer settings → OAuth Apps): `https://netpins.xyz/api/auth/callback/github`
- **Google** (Cloud Console → Credentials → OAuth client, Web): `https://netpins.xyz/api/auth/callback/google`

**Where are credentials stored?** Nowhere: there are no passwords. Sessions are encrypted JWT cookies (signed with `AUTH_SECRET`); D1 stores only a profile row and the user's projects. This is why Auth.js fits the free Workers plan (a password-hashing library would blow the 10 ms CPU limit).

---

## 5. AWS setup (S3 + IAM role)

The bucket is **private** (Block Public Access on); only the Worker's role can read/write it.

### 5.1 First deploy the Worker with an OIDC key

```bash
npm run oidc:keygen                                  # writes oidc-private-key.pem (git-ignored)
npx wrangler secret put OIDC_PRIVATE_KEY < oidc-private-key.pem
npm run deploy
curl https://netpins.xyz/.well-known/openid-configuration      # must return JSON
```

### 5.2 Create the bucket, OIDC provider and role

```bash
BUCKET=netlaunch-sites-<your-unique-suffix> DOMAIN=netpins.xyz REGION=us-east-1 ./aws/setup.sh
```

It prints the `AWS_ROLE_ARN`. Put it, `S3_BUCKET` and `AWS_REGION` in `wrangler.jsonc` → `vars`, then `npm run deploy`.

What the script creates (so you can audit it):

- **Trust policy:** only tokens issued by `https://netpins.xyz`, audience `sts.amazonaws.com`, subject `netlaunch-worker` can assume the role.
- **Permissions:** `s3:GetObject/PutObject/DeleteObject` on `sites/*`, `drafts/*`, `healthcheck/*` only, plus `s3:ListBucket` on the bucket (so S3 returns 404 instead of 403 for missing pages). Nothing else, no other buckets, no IAM.
- **Lifecycle:** abandoned `drafts/` expire after 60 days.

### 5.3 Prove it works

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "https://netpins.xyz/api/health?detail=1"
```

Each check (database, secrets, sign-in providers, Groq key, **S3 write/read/delete through the role**) reports `ok` or the exact reason it failed. Run it after every config change.

### 5.4 Fallback: access keys instead of a role

```bash
BUCKET=... MODE=keys ./aws/setup.sh      # prints a key pair once
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```
Then delete `AWS_ROLE_ARN` (and `OIDC_PRIVATE_KEY`) from the config. Same least-privilege policy; the only difference is the keys are long-lived.

### 5.5 Free alternative: Cloudflare R2

`STORAGE_DRIVER=r2` + the `r2_buckets` binding stores sites in R2 instead of S3 (10 GB free, no egress fees, no AWS account). The storage layer is one interface (`worker/storage/types.ts`), so nothing else changes.

---

## 6. Keeping it at $0: honest numbers

| Resource | Free allowance | What happens at the limit |
| --- | --- | --- |
| Cloudflare Workers | 100k requests/day, **10 ms CPU/request** | requests error until the daily reset |
| D1 | 5 GB, 5M reads/day, 100k writes/day | writes fail |
| **Groq `gpt-oss-120b` (free)** | **~8K tokens/min, ~1K requests/day, ~200K tokens/day for your whole org** (verify at console.groq.com/docs/rate-limits) | the app waits and retries, then shows "AI at capacity" |
| Groq Whisper (free) | ~20 req/min, ~2K req/day, ~8 h audio/day | friendly error |
| AWS S3 | **no permanent free tier on accounts created after July 2025** (credits for ~6 months; Free-plan accounts close afterwards) | pay-as-you-go: pennies at this scale |

Practical consequences:

- **Groq's free tier is the real ceiling:** one site build uses most of a minute's token budget, so expect roughly **one build per minute and ~20-30 builds per day in total**. That's fine for a demo or small launch; for more, add a card to Groq (pay-as-you-go is well under 1¢ per site) and set `GROQ_INCLUDE_PREVIOUS_HTML=true` for smarter edits.
- **Every page view of a published site costs one Worker request** (cached 60 s per region). ~100k views/day across all sites before the free limit.
- **AWS has no hard spending cap.** Guardrails built in: private bucket, per-user project cap (10), per-day AI/build/voice quotas (see `vars` in `worker/env.ts`), 400 KB site cap, ≤6 images of ≤1.5 MB each (compressed in the browser), guests limited to 1 project plus a per-IP limit. Add the alarm: `EMAIL=you@x.com ./aws/budget.sh`.
- If you want a *guaranteed* $0, use R2 (§5.5).

---

## 7. Security model (read this once)

- **User-generated pages share your origin.** Every published page is served with `Content-Security-Policy: sandbox allow-scripts …` **without** `allow-same-origin`, which gives it an opaque origin: its JavaScript can't read your cookies, call your API as the visitor, or touch other sites' storage. Side effect: generated pages can't use `localStorage`/cookies (the AI is told not to).
- Cookies are `HttpOnly; SameSite=Lax`; state-changing requests are also rejected if their `Origin` isn't yours.
- Uploaded images are verified by magic bytes (SVG is deliberately not allowed), re-served only from `sites/<name>/assets/`.
- Page names block reserved routes and common phishing words (`login`, `paypal`, …). Expect some abuse on any "publish anything" site: add a report link/email to your footer and be ready to delete a conversation (`DELETE /api/conversations/:id` takes the site offline).
- Secrets only ever live in Cloudflare secrets/`.dev.vars`; nothing sensitive is in the repo.

---

## 8. Error handling you get

Every API error is `{ error: { code, message, retryable, requestId } }` and the UI shows the message. Highlights: Groq 429s wait for `retry-after` and retry (user sees "The AI is busy, retrying in 8s"); truncated/invalid HTML is auto-repaired once; if storage fails after generation the draft is saved and **Retry deployment re-uses it without spending AI quota**; a build interrupted by a closed tab keeps running and the UI picks up the result; a crashed build is detected after 3 minutes and can be retried; offline state is detected; all unexpected errors are logged as structured JSON (Workers Logs) with the `requestId` shown to the user.

---

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Health check: storage `InvalidIdentityToken` / "Couldn't retrieve verification key" | AWS can't fetch `/.well-known/jwks.json`. Open it in a browser; check **Cloudflare → Security → Bots → Bot Fight Mode** isn't challenging AWS (turn it off, or use access keys §5.4). |
| `create-open-id-connect-provider` demands a thumbprint | Add `--thumbprint-list 0000000000000000000000000000000000000000` to the command in `aws/setup.sh` (AWS ignores it for CA-trusted hosts). |
| `AccessDenied` / 403 from S3 | Wrong `S3_BUCKET`/`AWS_REGION`, or the role policy. Re-run `aws/setup.sh` (idempotent). |
| "Exceeded CPU limit" in Workers logs | Free plan is 10 ms CPU. Check which route in the dashboard; Workers Paid ($5/mo) lifts it. |
| Sign-in button missing | No provider secrets set (`/api/health?detail=1` lists detected providers). |
| Sign-in redirects with an error | Callback URL in the OAuth app doesn't exactly match §4.3, or `AUTH_SECRET` is missing. |
| Mic button does nothing | Voice memos need HTTPS (or `localhost`) and mic permission. |
| "The AI is at capacity" | Groq free-tier limits (§6). Wait a minute, or upgrade Groq. |

---

## 10. Verification status

Covered by `npm test` (run in CI): the AWS SigV4 signer against AWS's published example signatures, OIDC JWT signing verified against the published JWKS, STS flow, slug rules, HTML validation, and the complete conversation → build → deploy → serve → revise → delete flow including quotas, ownership, CSRF, 429 retry, truncation repair and storage-outage recovery. The UI was exercised in headless Chromium with a fake microphone.

**Not executable in the authoring sandbox (no network):** real Groq, real S3/STS, real Auth.js OAuth round-trips, Tailwind compilation, and Cloudflare's runtime/CPU limits. Use §5.3's health check and a first real build as your acceptance test, and watch CPU time in the Workers dashboard for the first few builds.
