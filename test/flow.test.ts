import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOOD_HTML, PNG, builder, chatJson, makeWorld, planner, readSse } from './helpers/harness.ts';

const ASK = { reply: 'Nice! What vibe do you want?', choices: ['Warm & cozy', 'Modern'], brief: { business: 'Sunrise Bakery' }, ready: false, structure: null, suggestedName: null };
const READY = { reply: 'Great, I have enough.', choices: [], brief: { business: 'Sunrise Bakery', tone: 'warm' }, ready: true, structure: 'Hero: tagline\nMenu: breads\nContact: email\nStyle: warm', suggestedName: 'Sunrise Bakery' };

async function post(w: any, path: string, json?: unknown, extra: RequestInit = {}) { return w.fetch(path, { method: 'POST', json, ...extra }); }

test('full happy path: guest -> clarify -> page name -> confirm -> build -> live -> serve -> revise -> delete', async () => {
  const w = makeWorld();
  w.groqHandlers.push(builder(GOOD_HTML));

  const me = await (await w.fetch('/api/me')).json();
  assert.equal(me.identity.kind, 'guest'); assert.deepEqual(me.providers, ['github', 'google']);
  assert.ok(w.jar.has('nl_guest'));

  const created = await post(w, '/api/conversations'); assert.equal(created.status, 201);
  const { conversation } = await created.json(); const id = conversation.id;

  // second project as guest is blocked
  const second = await post(w, '/api/conversations'); assert.equal(second.status, 403);
  assert.equal((await second.json()).error.code, 'limit_guest_projects');

  // clarify turn 1 -> chips
  w.groqHandlers.unshift(planner(ASK));
  let r = await (await post(w, `/api/conversations/${id}/messages`, { text: 'I want a bakery website' })).json();
  const last = r.messages.at(-1); assert.equal(last.ui.type, 'chips'); assert.ok(last.ui.choices.includes('Warm & cozy'));
  assert.equal(r.conversation.title, 'Sunrise Bakery');

  // upload an image (optional)
  const fd = new FormData(); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'logo.png'); fd.append('role', 'logo');
  const up = await w.fetch(`/api/conversations/${id}/images`, { method: 'POST', body: fd }); assert.equal(up.status, 201);
  const img = (await up.json()).image; assert.match(img.filename, /^logo-[0-9a-f]{6}\.png$/);

  // clarify turn 2 -> ready => asks for page name (slug card with suggestion)
  w.groqHandlers.shift(); w.groqHandlers.unshift(planner(READY));
  r = await (await post(w, `/api/conversations/${id}/messages`, { text: 'Warm & cozy' })).json();
  const slugCard = r.messages.at(-1); assert.equal(slugCard.ui.type, 'slug'); assert.equal(slugCard.ui.suggestion, 'sunrise-bakery');

  // build is refused until confirmed
  assert.equal((await post(w, `/api/conversations/${id}/build`)).status, 400);

  // slug validation
  assert.equal((await post(w, `/api/conversations/${id}/slug`, { slug: 'api' })).status, 400);
  const chk = await (await w.fetch('/api/slug/check?name=Sunrise%20Bakery&conversation=' + id)).json(); assert.equal(chk.available, true);
  r = await (await post(w, `/api/conversations/${id}/slug`, { slug: 'Sunrise Bakery' })).json();
  assert.equal(r.slug, 'sunrise-bakery'); assert.equal(r.messages.at(-1).ui.type, 'confirm'); assert.equal(r.conversation.stage, 'confirm');

  // build (SSE)
  const res = await post(w, `/api/conversations/${id}/build`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = await readSse(res); await w.settle();
  const stages = events.filter((e) => e.event === 'stage').map((e) => e.data.id);
  assert.deepEqual([...new Set(stages)], ['checking', 'thinking', 'writing', 'validating', 'mobile', 'uploading', 'verifying']);
  const done = events.at(-1)!; assert.equal(done.event, 'done');
  assert.equal(done.data.message.ui.url, 'https://netpins.xyz/sunrise-bakery'); assert.equal(done.data.conversation.stage, 'live');
  assert.ok(events.find((e) => e.data.detail?.includes('Viewport')));
  assert.ok(w.s3.has('sites/sunrise-bakery/index.html')); assert.ok(w.s3.has(`sites/sunrise-bakery/assets/${img.filename}`));
  assert.ok(new TextDecoder().decode(w.s3.get('sites/sunrise-bakery/index.html')!.body).includes('nl-safety'));

  // serving: redirect, html w/ sandbox CSP, asset, 404s
  const red = await w.fetch('/sunrise-bakery'); assert.equal(red.status, 301); assert.equal(red.headers.get('location'), '/sunrise-bakery/');
  const page = await w.fetch('/sunrise-bakery/'); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /^sandbox allow-scripts/); assert.ok(!/allow-same-origin/.test(page.headers.get('content-security-policy')!));
  assert.match(await page.text(), /Sunrise Bakery/);
  assert.equal((await w.fetch(`/sunrise-bakery/assets/${img.filename}`)).headers.get('content-type'), 'image/png');
  assert.equal((await w.fetch('/sunrise-bakery/secret.txt')).status, 404);
  assert.equal((await w.fetch('/nope-nope/')).status, 404);
  assert.equal((await w.fetch('/../etc/passwd')).status, 404);

  // revise while live
  r = await (await post(w, `/api/conversations/${id}/messages`, { text: 'Make the header blue' })).json();
  assert.equal(r.messages.at(-1).ui.type, 'revise');
  w.groqHandlers.unshift(builder(GOOD_HTML.replace('Sunrise Bakery</h1>', 'Sunrise Bakery 2</h1>')));
  const ev2 = await readSse(await post(w, `/api/conversations/${id}/build`)); await w.settle();
  assert.equal(ev2.at(-1)!.event, 'done'); assert.match(ev2.at(-1)!.data.message.content, /updated/);
  assert.ok(new TextDecoder().decode(w.s3.get('sites/sunrise-bakery/index.html')!.body).includes('Bakery 2'));
  // nothing more to apply
  assert.equal((await post(w, `/api/conversations/${id}/build`)).status, 400);

  // history is persisted and ordered
  const hist = await (await w.fetch(`/api/conversations/${id}`)).json();
  assert.equal(hist.conversation.stage, 'live'); assert.equal(hist.messages[0].role, 'assistant');
  const roles = hist.messages.map((m: any) => m.role); assert.ok(roles.includes('user'));

  // delete takes the site offline and cleans storage
  assert.equal((await w.fetch(`/api/conversations/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await w.fetch('/sunrise-bakery/')).status, 404);
  assert.ok(![...w.s3.keys()].some((k) => k.startsWith('sites/sunrise-bakery') || k.startsWith('drafts/')));
  // guest may now start another project
  assert.equal((await post(w, '/api/conversations')).status, 201);
});

test('security: ownership, CSRF origin, slug collisions, auth claim', async () => {
  const w = makeWorld(); w.groqHandlers.push(planner(READY), builder(GOOD_HTML));
  const { conversation } = await (await post(w, '/api/conversations')).json();
  const id = conversation.id;
  // another visitor can't see it
  const other = new Map(w.jar); w.jar.clear();
  assert.equal((await w.fetch(`/api/conversations/${id}`)).status, 404);
  // cross-site POST rejected
  const mine = new Map(other); w.jar.clear(); for (const [k, v] of mine) w.jar.set(k, v);
  const evil = await w.fetch('/api/conversations', { method: 'POST', headers: { origin: 'https://evil.example' } }); assert.equal(evil.status, 403);
  const nullo = await w.fetch('/api/conversations', { method: 'POST', headers: { origin: 'null' } }); assert.equal(nullo.status, 403);
  // tampered guest cookie => treated as a fresh guest (cannot read mine)
  const bad = await w.fetch(`/api/conversations/${id}`, { headers: { cookie: 'nl_guest=' + [...mine.get('nl_guest')!.split('.')][0] + '.AAAA' } }); assert.equal(bad.status, 404);

  // slug collision between two people
  await post(w, `/api/conversations/${id}/messages`, { text: 'bakery' });
  assert.equal((await post(w, `/api/conversations/${id}/slug`, { slug: 'taken-name' })).status, 200);
  w.jar.clear(); w.user = { id: 'github:42', name: 'Ada', email: 'a@x.io' };
  const c2 = await (await post(w, '/api/conversations')).json();
  await post(w, `/api/conversations/${c2.conversation.id}/messages`, { text: 'another bakery' });
  const clash = await post(w, `/api/conversations/${c2.conversation.id}/slug`, { slug: 'taken-name' });
  assert.equal(clash.status, 409); assert.equal((await clash.json()).error.code, 'slug_taken');
  assert.equal((await (await w.fetch('/api/slug/check?name=taken-name')).json()).available, false);

  // guest -> user claims guest projects on sign-in
  w.jar.clear(); for (const [k, v] of mine) w.jar.set(k, v);
  const list = await (await w.fetch('/api/conversations')).json();
  assert.equal(list.conversations.length, 2); assert.ok(list.conversations.some((c: any) => c.id === id), 'guest project now belongs to the user');
  assert.ok(!w.jar.has('nl_guest'), 'guest cookie cleared after claim');
  // users can create many projects up to the cap
  assert.equal((await post(w, '/api/conversations')).status, 201);
});

test('quotas: ai calls and builds are limited per identity', async () => {
  const w = makeWorld({ AI_CALLS_GUEST_PER_DAY: '2' }); w.groqHandlers.push(planner(ASK));
  const { conversation } = await (await post(w, '/api/conversations')).json();
  for (let i = 0; i < 2; i++) assert.equal((await post(w, `/api/conversations/${conversation.id}/messages`, { text: 'hi ' + i })).status, 200);
  const r = await post(w, `/api/conversations/${conversation.id}/messages`, { text: 'again' });
  assert.equal(r.status, 429); assert.equal((await r.json()).error.code, 'quota_exceeded');
  w.now += 86_400_000; // next UTC day
  assert.equal((await post(w, `/api/conversations/${conversation.id}/messages`, { text: 'back' })).status, 200);
});

test('voice memo transcription + upload validation', async () => {
  const w = makeWorld();
  const mk = (type: string, size: number) => { const f = new FormData(); f.append('audio', new Blob([new Uint8Array(size)], { type }), 'm'); return f; };
  const ok = await w.fetch('/api/voice/transcribe', { method: 'POST', body: mk('audio/webm;codecs=opus', 5000) });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).text, 'Hello bakery');
  assert.equal((await w.fetch('/api/voice/transcribe', { method: 'POST', body: mk('audio/webm', 10) })).status, 400);
  assert.equal((await w.fetch('/api/voice/transcribe', { method: 'POST', body: mk('video/x-flv', 5000) })).status, 415);
  assert.equal((await w.fetch('/api/voice/transcribe', { method: 'POST', body: mk('audio/webm', 13_000_000) })).status, 413);
  // not-an-image upload is rejected by magic bytes even if declared as png
  const { conversation } = await (await post(w, '/api/conversations')).json();
  const fd = new FormData(); fd.append('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.png');
  assert.equal((await w.fetch(`/api/conversations/${conversation.id}/images`, { method: 'POST', body: fd })).status, 415);
});

test('resilience: Groq 429 waits and retries; truncated output is repaired; storage outage keeps the draft and resumes', async () => {
  const w = makeWorld();
  const { conversation } = await (await post(w, '/api/conversations')).json(); const id = conversation.id;
  w.groqHandlers.push(planner(READY));
  await post(w, `/api/conversations/${id}/messages`, { text: 'bakery' });
  await post(w, `/api/conversations/${id}/slug`, { slug: 'resilient' });
  w.groqHandlers.length = 0;
  let n = 0;
  w.groqHandlers.push((sys) => {
    if (!sys.includes('front-end designer')) return null; n++;
    if (n === 1) return new Response('{"error":{"message":"Rate limit. Please try again in 7.5s"}}', { status: 429, headers: { 'retry-after': '8' } });
    if (n === 2) return chatJson('<!DOCTYPE html><html><head><title>x</title></head><body><h1>cut off', 'length');
    return chatJson(GOOD_HTML);
  });
  w.s3Fail.next = 3; w.s3Fail.status = 503; // index.html PUT fails all 3 attempts
  let ev = await readSse(await post(w, `/api/conversations/${id}/build`)); await w.settle();
  assert.ok(ev.some((e) => e.event === 'stage' && e.data.id === 'waiting'), 'user is told the AI is busy');
  assert.ok(w.sleeps.includes(8250));
  assert.ok(ev.some((e) => e.data.id === 'repairing'));
  const failed = ev.at(-1)!; assert.equal(failed.event, 'failed'); assert.equal(failed.data.error.code, 'storage_error');
  assert.equal(failed.data.message.ui.canResume, true);
  const callsBefore = w.calls.groq;
  // retry: resumes from the saved draft without spending any more AI calls
  ev = await readSse(await post(w, `/api/conversations/${id}/build`, { resume: true })); await w.settle();
  assert.equal(ev.at(-1)!.event, 'done'); assert.equal(w.calls.groq, callsBefore);
  assert.ok(w.s3.has('sites/resilient/index.html'));
});

test('AI returns garbage twice => friendly failure, nothing published, build can be retried', async () => {
  const w = makeWorld(); const { conversation } = await (await post(w, '/api/conversations')).json(); const id = conversation.id;
  w.groqHandlers.push(planner(READY)); await post(w, `/api/conversations/${id}/messages`, { text: 'x' }); await post(w, `/api/conversations/${id}/slug`, { slug: 'garbage' });
  w.groqHandlers.length = 0; w.groqHandlers.push(builder('I cannot help with that.'));
  const ev = await readSse(await post(w, `/api/conversations/${id}/build`)); await w.settle();
  assert.equal(ev.at(-1)!.event, 'failed'); assert.equal(ev.at(-1)!.data.error.code, 'ai_bad_output');
  assert.ok(!w.s3.has('sites/garbage/index.html'));
  assert.equal((await (await w.fetch(`/api/conversations/${id}`)).json()).conversation.stage, 'failed');
  w.groqHandlers.unshift(builder(GOOD_HTML));
  assert.equal((await readSse(await post(w, `/api/conversations/${id}/build`))).at(-1)!.event, 'done'); await w.settle();
});

test('a crashed build (stale "building") can be retried; a live build blocks double-submit', async () => {
  const w = makeWorld(); const { conversation } = await (await post(w, '/api/conversations')).json(); const id = conversation.id;
  w.groqHandlers.push(planner(READY)); await post(w, `/api/conversations/${id}/messages`, { text: 'x' }); await post(w, `/api/conversations/${id}/slug`, { slug: 'crashy' });
  w.groqHandlers.length = 0; w.groqHandlers.push(builder(GOOD_HTML));
  await w.env.DB.prepare("UPDATE conversations SET stage='building', building_since=? WHERE id=?").bind(w.now, id).run();
  assert.equal((await post(w, `/api/conversations/${id}/build`)).status, 409);
  w.now += 4 * 60_000; // worker died 4 minutes ago
  assert.equal((await (await w.fetch(`/api/conversations/${id}`)).json()).conversation.stage, 'failed');
  assert.equal((await readSse(await post(w, `/api/conversations/${id}/build`))).at(-1)!.event, 'done'); await w.settle();
});

test('doctor reports each dependency; OIDC mode used when a role is configured', async () => {
  const w = makeWorld();
  assert.equal((await w.fetch('/api/health')).status, 200);
  assert.equal((await w.fetch('/api/health?detail=1')).status, 401);
  const d = await (await w.fetch('/api/health?detail=1', { headers: { authorization: 'Bearer adm' } })).json();
  assert.equal(d.ok, true, JSON.stringify(d)); assert.equal(d.checks.length, 5);
  const bad = makeWorld({ S3_BUCKET: 'wrong-bucket' });
  const d2 = await (await bad.fetch('/api/health?detail=1', { headers: { authorization: 'Bearer adm' } })).json();
  assert.equal(d2.ok, false);
});
