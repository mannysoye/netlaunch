import { groqTranscribe, audioExt } from '../ai/groq.ts';
import { enforce } from '../context.ts';
import type { Ctx, Router } from '../context.ts';
import type { ConversationRow, ImageRow, MessageRow } from '../db.ts';
import { parseBrief } from '../domain/brief.ts';
import { checkSlug } from '../domain/slug.ts';
import { effectiveStage, groqDeps, handleUserMessage, setPageName } from '../flow.ts';
import { AppError, json, readJson } from '../http.ts';
import { draftKey, siteKey } from '../storage/types.ts';

export const conversationDto = (c: Ctx, r: ConversationRow) => ({
  id: r.id, title: r.title, stage: effectiveStage(c, r), slug: r.slug, url: r.live_url,
  error: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
});
export const messageDto = (m: MessageRow) => ({ id: m.id, role: m.role, content: m.content, ui: m.ui ? JSON.parse(m.ui) : null, createdAt: m.created_at });
export const imageDto = (i: ImageRow) => ({ id: i.id, filename: i.filename, role: i.role, caption: i.caption, bytes: i.bytes });

async function owned(c: Ctx): Promise<ConversationRow> {
  const row = await c.repo.getConversation(c.params.id!, c.identity.id);
  if (!row) throw new AppError('not_found', 'That project doesn’t exist (or isn’t yours).', 404);
  return row;
}

/** Identify an image by its first bytes; never trust the client-declared type. */
export function sniffImage(b: Uint8Array): { mime: string; ext: string } | null {
  const at = (s: string, o = 0) => [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  if (b[0] === 0x89 && at('PNG', 1)) return { mime: 'image/png', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (at('GIF8')) return { mime: 'image/gif', ext: 'gif' };
  if (at('RIFF') && at('WEBP', 8)) return { mime: 'image/webp', ext: 'webp' };
  return null;
}

export function registerConversationRoutes(r: Router) {
  r.get('/api/me', async (c) => {
    if (c.identity.kind === 'user') await c.repo.upsertUser({ id: c.identity.id, email: c.identity.email, name: c.identity.name, image: c.identity.image }, c.deps.now());
    if (Math.random() < 0.02) c.exec.waitUntil(c.repo.pruneUsage(c.deps.now()));
    const count = await c.repo.countConversations(c.identity.id);
    const max = c.identity.kind === 'guest' ? c.cfg.guestMaxProjects : c.cfg.userMaxProjects;
    return json({
      identity: { kind: c.identity.kind, name: c.identity.name ?? null, email: c.identity.email ?? null, image: c.identity.image ?? null },
      providers: c.deps.auth.providers(c.env),
      limits: { projects: max, used: count, memoMaxSeconds: 300 },
      host: c.origin.replace(/^https?:\/\//, ''),
    });
  });

  r.get('/api/conversations', async (c) => {
    const rows = await c.repo.listConversations(c.identity.id);
    return json({ conversations: rows.map((x) => conversationDto(c, x)) });
  });

  r.post('/api/conversations', async (c) => {
    const count = await c.repo.countConversations(c.identity.id);
    if (c.identity.kind === 'guest') {
      if (count >= c.cfg.guestMaxProjects) throw new AppError('limit_guest_projects', 'Guests can create one project. Create a free account to start more.', 403);
      const ip = c.req.headers.get('cf-connecting-ip') ?? 'unknown';
      const data = new TextEncoder().encode(`${ip}|${c.env.AUTH_SECRET}`);
      const ipKey = 'ip:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
      if (!(await c.repo.consume(ipKey, 'guest_conv', c.cfg.guestConversationsPerIpPerDay, c.deps.now()))) {
        throw new AppError('rate_limited', 'Too many new projects from this network today. Please sign in or try tomorrow.', 429);
      }
    } else if (count >= c.cfg.userMaxProjects) {
      throw new AppError('limit_projects', `You can have up to ${c.cfg.userMaxProjects} projects. Delete one to make room.`, 403);
    }
    const row = await c.repo.createConversation(c.deps.uuid(), c.identity.id, c.deps.now());
    const hello = await c.repo.addMessage({
      id: c.deps.uuid(), conversationId: row.id, role: 'assistant', content:
        'Hi! I’m NetLaunch. Tell me about the website you want, by typing or with a voice memo, and I’ll build and publish it for you.',
      ui: { type: 'chips', choices: ['A portfolio site', 'A restaurant or cafe', 'A product landing page', 'A small business page'] },
    }, c.deps.now());
    return json({ conversation: conversationDto(c, row), messages: [messageDto(hello)], images: [] }, 201);
  });

  r.get('/api/conversations/:id', async (c) => {
    const row = await owned(c);
    const [messages, images] = await Promise.all([c.repo.listMessages(row.id), c.repo.listImages(row.id)]);
    return json({ conversation: conversationDto(c, row), messages: messages.map(messageDto), images: images.map(imageDto), brief: { pageName: parseBrief(row.brief).pageName ?? null } });
  });

  r.delete('/api/conversations/:id', async (c) => {
    const row = await owned(c);
    if (effectiveStage(c, row) === 'building') throw new AppError('conflict', 'Wait for the build to finish before deleting.', 409);
    const images = await c.repo.listImages(row.id);
    // Take the site offline and remove stored files first; only then drop the rows.
    const st = c.storage();
    const keys = [...images.map((i) => i.key)];
    if (row.slug) keys.push(siteKey(row.slug, 'index.html'), ...images.map((i) => siteKey(row.slug!, `assets/${i.filename}`)));
    for (const k of keys) await st.delete(k);
    await c.repo.deleteConversation(row.id);
    return json({ ok: true });
  });

  r.get('/api/slug/check', async (c) => {
    const check = checkSlug(c.url.searchParams.get('name') ?? '');
    if (!check.ok) return json({ available: false, slug: check.slug, reason: check.reason });
    const available = await c.repo.slugAvailable(check.slug, c.url.searchParams.get('conversation'), c.deps.now());
    return json({ available, slug: check.slug, reason: available ? null : 'That name is already taken.' });
  });

  r.post('/api/conversations/:id/slug', async (c) => {
    const row = await owned(c);
    const body = await readJson<{ slug?: string }>(c.req, 1000);
    const res = await setPageName(c, row, String(body.slug ?? ''));
    return json({ conversation: conversationDto(c, res.conversation), messages: res.messages.map(messageDto), slug: res.slug });
  });

  r.post('/api/conversations/:id/messages', async (c) => {
    const row = await owned(c);
    const body = await readJson<{ text?: string }>(c.req, 20_000);
    const text = String(body.text ?? '').trim();
    if (!text) throw new AppError('bad_request', 'Please type or record something first.', 400);
    if (text.length > 8000) throw new AppError('payload_too_large', 'That message is too long (max 8,000 characters).', 413);
    const res = await handleUserMessage(c, row, text);
    return json({ conversation: conversationDto(c, res.conversation), messages: res.messages.map(messageDto) });
  });

  /* ------------------------------- images ------------------------------- */
  r.post('/api/conversations/:id/images', async (c) => {
    const row = await owned(c);
    if (effectiveStage(c, row) === 'building') throw new AppError('conflict', 'Wait for the build to finish.', 409);
    const existing = await c.repo.listImages(row.id);
    if (existing.length >= c.cfg.maxImages) throw new AppError('bad_request', `You can attach up to ${c.cfg.maxImages} images.`, 400);
    let form: FormData;
    try { form = await c.req.formData(); } catch { throw new AppError('bad_request', 'Expected a multipart upload.', 400); }
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new AppError('bad_request', 'No image was attached.', 400);
    if (file.size > c.cfg.maxImageBytes) throw new AppError('payload_too_large', `Images must be under ${(c.cfg.maxImageBytes / 1e6).toFixed(1)} MB.`, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffImage(bytes);
    if (!kind) throw new AppError('unsupported_media', 'Please upload a PNG, JPG, WebP or GIF image.', 415);
    const role = ['logo', 'hero', 'gallery', 'other'].includes(String(form.get('role'))) ? String(form.get('role')) : 'other';
    const caption = String(form.get('caption') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
    const id = c.deps.uuid();
    const filename = `${role}-${id.slice(0, 6)}.${kind.ext}`;
    const key = draftKey(row.id, id);
    await c.storage().put(key, bytes, { contentType: kind.mime, cacheControl: 'private, max-age=3600' });
    await c.repo.addImage({ id, conversation_id: row.id, key, filename, role, caption, mime: kind.mime, bytes: bytes.byteLength }, c.deps.now());
    return json({ image: imageDto({ id, conversation_id: row.id, key, filename, role, caption, mime: kind.mime, bytes: bytes.byteLength, created_at: 0 }) }, 201);
  });

  r.get('/api/conversations/:id/images/:imageId', async (c) => {
    const row = await owned(c);
    const img = await c.repo.getImage(row.id, c.params.imageId!);
    if (!img) throw new AppError('not_found', 'Image not found.', 404);
    const obj = await c.storage().get(img.key);
    if (!obj) throw new AppError('not_found', 'Image not found.', 404);
    return new Response(obj.body, { headers: { 'content-type': img.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
  });

  r.delete('/api/conversations/:id/images/:imageId', async (c) => {
    const row = await owned(c);
    const img = await c.repo.getImage(row.id, c.params.imageId!);
    if (img) {
      await c.storage().delete(img.key);
      await c.repo.deleteImage(img.id);
    }
    return json({ ok: true });
  });

  /* -------------------------------- voice -------------------------------- */
  r.post('/api/voice/transcribe', async (c) => {
    let form: FormData;
    try { form = await c.req.formData(); } catch { throw new AppError('bad_request', 'Expected a multipart upload.', 400); }
    const audio = form.get('audio');
    if (!(audio instanceof Blob)) throw new AppError('bad_request', 'No audio was received.', 400);
    if (audio.size < 800) throw new AppError('bad_request', 'That recording was too short. Hold on a little longer and speak up.', 400);
    if (audio.size > c.cfg.maxAudioBytes) throw new AppError('payload_too_large', 'That recording is too large. Voice memos are limited to 5 minutes.', 413);
    const mime = audio.type || 'audio/webm';
    if (!audioExt(mime)) throw new AppError('unsupported_media', 'Your browser recorded in a format we can’t transcribe.', 415);
    await enforce(c, 'stt');
    const text = await groqTranscribe(groqDeps(c), { model: c.cfg.sttModel, audio, mime });
    if (!text) throw new AppError('bad_request', 'I couldn’t hear any speech in that recording. Try again a bit closer to the mic.', 422);
    return json({ text });
  });
}
