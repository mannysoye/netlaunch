import { generateSite } from '../ai/agents.ts';
import { enforce } from '../context.ts';
import type { Ctx, Router } from '../context.ts';
import { effectiveStage, groqDeps } from '../flow.ts';
import { parseBrief } from '../domain/brief.ts';
import { applyMobileSafety, mobileReport, sanitizeHtml, validateHtml } from '../domain/html.ts';
import { AppError, errorBody } from '../http.ts';
import { siteKey } from '../storage/types.ts';
import { conversationDto, messageDto } from './conversations.ts';

type Emit = (event: string, data: unknown) => void;

/** Run `work` in the background while streaming its progress as Server-Sent Events. Survives client disconnects. */
function sse(c: Ctx, work: (emit: Emit) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const write = (s: string) => { if (open) writer.write(enc.encode(s)).catch(() => { open = false; }); };
  const emit: Emit = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => write(': ping\n\n'), 8000);
  c.exec.waitUntil(
    (async () => {
      try { await work(emit); } finally { clearInterval(ping); await writer.close().catch(() => {}); }
    })(),
  );
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}

export function registerBuildRoute(r: Router) {
  r.post('/api/conversations/:id/build', async (c) => {
    const row = await c.repo.getConversation(c.params.id!, c.identity.id);
    if (!row) throw new AppError('not_found', 'That project doesn’t exist (or isn’t yours).', 404);

    const body = (await c.req.json().catch(() => ({}))) as { resume?: boolean };
    const stage = effectiveStage(c, row);
    const brief = parseBrief(row.brief);
    const resume = body.resume === true && !!row.pending_html;
    if (stage === 'building') throw new AppError('conflict', 'A build is already running for this project.', 409);
    if (!brief.ready || !brief.pageName || !row.slug) throw new AppError('bad_request', 'We still need a bit more info (and a page name) before building.', 400);
    if (stage === 'live' && !brief.pendingRevision && !resume) throw new AppError('bad_request', 'Nothing to update yet. Tell me what you’d like to change.', 400);
    if (stage === 'clarify') throw new AppError('bad_request', 'Please confirm the layout first.', 400);

    if (!resume) { await enforce(c, 'build'); await enforce(c, 'ai'); }
    const started = await c.repo.beginBuild(row.id, c.deps.now(), c.cfg.buildStaleMs);
    if (!started) throw new AppError('conflict', 'A build is already running for this project.', 409);
    // Fail fast (before streaming) if storage is not configured.
    const storage = c.storage();

    return sse(c, async (emit) => {
      const slug = row.slug!;
      let html: string | null = resume ? row.pending_html : null;
      const stageEvt = (id: string, label: string, detail?: string) => emit('stage', { id, label, detail });
      try {
        stageEvt('checking', 'Checking your brief');
        const images = await c.repo.listImages(row.id);

        if (!html) {
          let previousHtml: string | undefined;
          if (c.cfg.includePreviousHtml && stage === 'live') {
            const prev = await storage.get(siteKey(slug, 'index.html'));
            if (prev) previousHtml = new TextDecoder().decode(prev.body);
          }
          stageEvt('thinking', 'Thinking through your design');
          const gen = await generateSite(groqDeps(c), c.cfg, { brief, images: images.map((i) => ({ filename: i.filename, role: i.role, caption: i.caption })), previousHtml }, {
            onStage: (s) => {
              if (s === 'writing') stageEvt('writing', 'Writing the code');
              if (s === 'repairing') stageEvt('repairing', 'Polishing a few rough edges');
              if (s === 'validating') stageEvt('validating', 'Compiling and validating the code');
            },
            onWait: (sec) => stageEvt('waiting', `The AI is busy, retrying in ${sec}s`),
          });
          html = gen.html;
        } else {
          stageEvt('validating', 'Re-using your saved draft');
        }

        stageEvt('mobile', 'Checking the mobile layout');
        html = applyMobileSafety(sanitizeHtml(html));
        const checks = mobileReport(html);
        const v = validateHtml(html, c.cfg.maxSiteBytes);
        if (!v.ok && v.errors.some((e) => /too large|Missing/.test(e))) throw new AppError('ai_bad_output', 'The generated page didn’t pass our checks. Please try again.', 502, true);
        emit('stage', { id: 'mobile', label: 'Checking the mobile layout', detail: checks.map((x) => `${x.ok ? '✓' : '•'} ${x.name}`).join('\n') });

        stageEvt('uploading', 'Deploying to the cloud');
        for (const img of images) {
          // Image filenames embed a unique id, so an existing site asset is identical: skip the copy (also survives expired drafts).
          const dst = siteKey(slug, `assets/${img.filename}`);
          if (!(await storage.head(dst))) await storage.copy(img.key, dst);
        }
        const bytes = new TextEncoder().encode(html);
        await storage.put(siteKey(slug, 'index.html'), bytes, { contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=60' });

        stageEvt('verifying', 'Verifying your site is live');
        const head = await storage.head(siteKey(slug, 'index.html'));
        if (!head || head.size !== bytes.byteLength) throw new AppError('storage_error', 'The upload finished but we couldn’t verify it. Please retry.', 502, true);

        const url = `${c.origin}/${slug}`;
        const fresh = parseBrief(row.brief);
        if (fresh.pendingRevision) {
          fresh.revisions = [...(fresh.revisions ?? []), fresh.pendingRevision].slice(-8);
          delete fresh.pendingRevision;
        }
        await c.repo.updateConversation(row.id, {
          stage: 'live', live_url: url, site_bytes: bytes.byteLength, pending_html: null, last_error: null, building_since: null, brief: JSON.stringify(fresh),
        }, c.deps.now());
        const msg = await c.repo.addMessage({
          id: c.deps.uuid(), conversationId: row.id, role: 'assistant',
          content: row.live_url ? 'Your site has been updated and is live again.' : 'Your site is live! 🎉',
          ui: { type: 'live', url, slug },
        }, c.deps.now());
        const conv = (await c.repo.getConversation(row.id, c.identity.id))!;
        emit('done', { conversation: conversationDto(c, conv), message: messageDto(msg), images: images.map((i) => i.filename) });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError('internal', 'Something went wrong while building your site.', 500, true);
        if (!(e instanceof AppError)) console.error(JSON.stringify({ level: 'error', requestId: c.requestId, where: 'build', message: (e as Error)?.message }));
        const hadHtml = !!html;
        try {
          await c.repo.updateConversation(row.id, {
            stage: row.live_url ? 'live' : 'failed', last_error: err.message, building_since: null,
            pending_html: hadHtml && err.code === 'storage_error' ? html : null,
          }, c.deps.now());
          const msg = await c.repo.addMessage({
            id: c.deps.uuid(), conversationId: row.id, role: 'assistant',
            content: `I hit a problem: ${err.message}`,
            ui: { type: 'error', code: err.code, retryable: err.retryable, canResume: hadHtml && err.code === 'storage_error' },
          }, c.deps.now());
          const conv = (await c.repo.getConversation(row.id, c.identity.id))!;
          emit('failed', { error: errorBody(err, c.requestId).body.error, conversation: conversationDto(c, conv), message: messageDto(msg) });
        } catch {
          emit('failed', { error: errorBody(err, c.requestId).body.error });
        }
      }
    });
  });
}
