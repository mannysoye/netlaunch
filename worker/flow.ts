import { runPlanner } from './ai/agents.ts';
import type { GroqDeps } from './ai/groq.ts';
import { enforce } from './context.ts';
import type { Ctx } from './context.ts';
import type { ConversationRow, MessageRow } from './db.ts';
import { mergeBrief, parseBrief } from './domain/brief.ts';
import type { Brief } from './domain/brief.ts';
import { checkSlug, normalizeSlug } from './domain/slug.ts';
import { AppError } from './http.ts';

export const groqDeps = (c: Pick<Ctx, 'env' | 'deps'>): GroqDeps => ({ fetch: c.deps.fetch, sleep: c.deps.sleep, apiKey: c.env.GROQ_API_KEY });

export const hostLabel = (c: Pick<Ctx, 'origin'>): string => c.origin.replace(/^https?:\/\//, '');

/** Persist an assistant message. */
export async function say(c: Ctx, conversationId: string, content: string, ui?: unknown): Promise<MessageRow> {
  return c.repo.addMessage({ id: c.deps.uuid(), conversationId, role: 'assistant', content, ui }, c.deps.now());
}

/** Is a "building" row actually stale (worker died mid-build)? Report such rows as failed. */
export function effectiveStage(c: Pick<Ctx, 'cfg' | 'deps'>, row: ConversationRow): ConversationRow['stage'] {
  if (row.stage === 'building' && (row.building_since ?? 0) < c.deps.now() - c.cfg.buildStaleMs) return row.live_url ? 'live' : 'failed';
  return row.stage;
}

async function suggestSlug(c: Ctx, brief: Brief, hint: string | null, conversationId: string): Promise<string | undefined> {
  for (const candidate of [hint, brief.business]) {
    if (!candidate) continue;
    const r = checkSlug(candidate);
    if (r.ok && (await c.repo.slugAvailable(r.slug, conversationId, c.deps.now()))) return r.slug;
  }
  return undefined;
}

function confirmContent(c: Ctx, brief: Brief): string {
  return `Here’s the plan for **${hostLabel(c)}/${brief.pageName}**:\n\n${brief.structure}\n\nHappy with this? Tap **Build & deploy**, or tell me what to change.`;
}

/** After the brief becomes "ready", either ask for the page name or present the structure for confirmation. */
async function advance(c: Ctx, conv: ConversationRow, brief: Brief, hint: string | null): Promise<MessageRow[]> {
  const out: MessageRow[] = [];
  if (!brief.ready || !brief.structure) return out;
  if (!brief.pageName) {
    const suggestion = await suggestSlug(c, brief, hint, conv.id);
    out.push(await say(c, conv.id, `I have what I need. One last thing: what should we **name your page**? It will live at **${hostLabel(c)}/your-name**.`, { type: 'slug', suggestion }));
    return out;
  }
  await c.repo.updateConversation(conv.id, { stage: 'confirm' }, c.deps.now());
  out.push(await say(c, conv.id, confirmContent(c, brief), { type: 'confirm', slug: brief.pageName }));
  return out;
}

export async function handleUserMessage(c: Ctx, conv: ConversationRow, text: string): Promise<{ messages: MessageRow[]; conversation: ConversationRow }> {
  const stage = effectiveStage(c, conv);
  if (stage === 'building') throw new AppError('conflict', 'I’m still building your site, one moment.', 409);

  let brief = parseBrief(conv.brief);
  const userMsg = await c.repo.addMessage({ id: c.deps.uuid(), conversationId: conv.id, role: 'user', content: text }, c.deps.now());
  const out: MessageRow[] = [userMsg];

  if (stage === 'live') {
    // Edits to a live site: queue the change; the client then calls /build which redeploys.
    brief.pendingRevision = [brief.pendingRevision, text.slice(0, 600)].filter(Boolean).join(' | ').slice(0, 1500);
    await c.repo.updateConversation(conv.id, { brief: JSON.stringify(brief) }, c.deps.now());
    out.push(await say(c, conv.id, 'Got it. I’ll apply that and redeploy your site.', { type: 'revise' }));
  } else {
    await enforce(c, 'ai');
    const mode = stage === 'confirm' || stage === 'failed' ? 'confirm' : 'clarify';
    if (!brief.idea) brief.idea = text.slice(0, 800);
    const turn = conv.clarify_turns + (mode === 'clarify' ? 1 : 0);
    const images = (await c.repo.listImages(conv.id)).map((i) => ({ filename: i.filename, role: i.role, caption: i.caption }));
    const history = (await c.repo.listMessages(conv.id, 12)).map((m) => ({ role: m.role, content: m.content }));
    const res = await runPlanner(groqDeps(c), c.cfg, { brief, images, history, stage: mode === 'confirm' ? 'confirm' : 'clarify', turn });

    brief = mergeBrief(brief, res.brief);
    if (res.ready && res.structure) { brief.ready = true; brief.structure = res.structure; }
    const patch: Parameters<typeof c.repo.updateConversation>[1] = { brief: JSON.stringify(brief), clarify_turns: turn };
    if (conv.title === 'New site') patch.title = (brief.business ?? brief.idea ?? 'New site').slice(0, 50);
    await c.repo.updateConversation(conv.id, patch, c.deps.now());

    const showChoices = !brief.ready && res.choices.length > 0;
    const quick = brief.ready ? undefined : [...res.choices.map((x) => x.label), 'Skip questions, use smart defaults'];
    if (brief.ready) {
      out.push(await say(c, conv.id, res.reply));
      out.push(...(await advance(c, conv, brief, res.suggestedName)));
    } else {
      out.push(await say(c, conv.id, res.reply, { type: 'chips', choices: showChoices ? quick : ['Skip questions, use smart defaults'] }));
    }
  }
  return { messages: out, conversation: (await c.repo.getConversation(conv.id, c.identity.id))! };
}

/** Called when the person submits a page name. */
export async function setPageName(c: Ctx, conv: ConversationRow, input: string): Promise<{ messages: MessageRow[]; conversation: ConversationRow; slug: string }> {
  const stage = effectiveStage(c, conv);
  if (stage === 'building' || (stage === 'live' && conv.slug)) throw new AppError('conflict', 'This site is already live; its page name can’t be changed.', 409);
  const r = checkSlug(input);
  if (!r.ok) throw new AppError('slug_invalid', r.reason, 400);
  const now = c.deps.now();
  if (!(await c.repo.slugAvailable(r.slug, conv.id, now))) throw new AppError('slug_taken', 'That page name is already taken. Try another.', 409);
  await c.repo.reserveSlug(conv.id, r.slug, now);

  const brief = parseBrief(conv.brief);
  brief.pageName = r.slug;
  await c.repo.updateConversation(conv.id, { brief: JSON.stringify(brief) }, c.deps.now());
  const out: MessageRow[] = [];
  out.push(await c.repo.addMessage({ id: c.deps.uuid(), conversationId: conv.id, role: 'user', content: `Page name: ${r.slug}` }, c.deps.now()));
  if (brief.ready) out.push(...(await advance(c, { ...conv, slug: r.slug }, brief, null)));
  else out.push(await say(c, conv.id, `Great, **${hostLabel(c)}/${r.slug}** is reserved for you. Tell me a bit more about the site.`));
  return { messages: out, conversation: (await c.repo.getConversation(conv.id, c.identity.id))!, slug: r.slug };
}

export { normalizeSlug };
