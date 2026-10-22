import type { Config } from '../env.ts';
import { AppError } from '../http.ts';
import { briefForPrompt, normalizePlanner, parseJsonLoose } from '../domain/brief.ts';
import type { Brief, ImageInfo, PlannerResult } from '../domain/brief.ts';
import { extractHtml, validateHtml } from '../domain/html.ts';
import { groqChat } from './groq.ts';
import type { GroqDeps, Hooks } from './groq.ts';
import { BUILDER_SYSTEM, PLANNER_SYSTEM } from './prompts.ts';

export interface PlannerInput {
  brief: Brief;
  images: ImageInfo[];
  history: { role: 'user' | 'assistant'; content: string }[]; // includes the newest user message
  stage: 'clarify' | 'confirm';
  turn: number;
}

export async function runPlanner(groq: GroqDeps, cfg: Config, input: PlannerInput): Promise<PlannerResult> {
  const forced = input.turn >= cfg.maxClarifyTurns;
  const context =
    `BRIEF: ${briefForPrompt(input.brief, input.images)}\n` +
    `STAGE: ${input.stage}${input.stage === 'clarify' ? ` (turn ${input.turn} of ${cfg.maxClarifyTurns})` : ' (the person is reviewing your proposed structure)'}\n` +
    (input.brief.structure && input.stage === 'confirm' ? `CURRENT STRUCTURE:\n${input.brief.structure}\n` : '') +
    (forced && input.stage === 'clarify' ? 'You have asked enough: set ready=true now, fill in sensible defaults and provide the structure.\n' : '');

  const messages = [
    { role: 'system' as const, content: PLANNER_SYSTEM },
    { role: 'user' as const, content: context },
    ...input.history.slice(-8).map((m, i, a) => ({ role: m.role, content: m.content.slice(0, i === a.length - 1 ? 3500 : 800) })),
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await groqChat(groq, { model: cfg.model, messages, maxTokens: 1400, temperature: 0.5, reasoningEffort: 'low', json: true });
    const parsed = normalizePlanner(parseJsonLoose(out.text));
    if (parsed) {
      if (forced && input.stage === 'clarify') parsed.ready = true;
      if (parsed.ready && !parsed.structure) parsed.ready = false; // can't confirm what we haven't described
      return parsed;
    }
    messages.push({ role: 'user', content: 'That was not valid JSON in the required shape. Reply with ONLY the JSON object.' });
  }
  // Graceful degradation: keep the conversation going rather than failing the user.
  return { reply: 'Sorry, I got a bit tangled. Could you tell me a little more about the site you want?', choices: [], brief: {}, ready: false, structure: null, suggestedName: null };
}

export interface BuildInput {
  brief: Brief;
  images: ImageInfo[];
  previousHtml?: string;
}
export interface BuildHooks extends Hooks {
  onStage?: (stage: 'writing' | 'validating' | 'repairing', detail?: string) => void;
}

/** Generates and validates a site. At most two model calls: the second only if the first fails validation. */
export async function generateSite(groq: GroqDeps, cfg: Config, input: BuildInput, hooks: BuildHooks = {}): Promise<{ html: string; warnings: string[] }> {
  const revisions = input.brief.revisions?.length ? `\nCHANGES REQUESTED AFTER LAUNCH (apply all): ${input.brief.revisions.join(' | ')}` : '';
  const pending = input.brief.pendingRevision ? `\nNEW CHANGE REQUEST (highest priority): ${input.brief.pendingRevision}` : '';
  const user =
    `BRIEF: ${briefForPrompt(input.brief, input.images)}\n` +
    `LAYOUT TO FOLLOW:\n${input.brief.structure ?? '(use your judgement)'}` + revisions + pending +
    (input.previousHtml ? `\n\nCURRENT HTML (modify it, keep what works):\n${input.previousHtml}` : '');

  const messages = [{ role: 'system' as const, content: BUILDER_SYSTEM }, { role: 'user' as const, content: user }];
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    hooks.onStage?.(attempt === 1 ? 'writing' : 'repairing');
    const out = await groqChat(groq, {
      model: cfg.model, maxTokens: cfg.buildMaxTokens, temperature: 0.7, reasoningEffort: 'low',
      messages: feedback ? [...messages, { role: 'user' as const, content: feedback }] : messages,
    }, hooks);
    hooks.onStage?.('validating');
    const ex = extractHtml(out.text);
    if (ex && ex.complete) {
      const v = validateHtml(ex.html, cfg.maxSiteBytes);
      // lorem ipsum etc. are errors worth one repair; anything else on the 2nd try is accepted with warnings
      if (v.ok) return { html: ex.html, warnings: [] };
      if (attempt === 2 && !v.errors.some((e) => /Missing|Unbalanced|too large/.test(e))) return { html: ex.html, warnings: v.errors };
      feedback = `Your previous output had problems: ${v.errors.join(' ')} Return the corrected, complete HTML document only.`;
    } else {
      feedback = out.finishReason === 'length' || (ex && !ex.complete)
        ? 'Your previous output was cut off. Return a MORE COMPACT complete HTML document (under 14KB): shorter CSS, fewer sections of copy. HTML only.'
        : 'Your previous output was not an HTML document. Return ONLY the complete HTML document starting with <!DOCTYPE html>.';
    }
  }
  throw new AppError('ai_bad_output', 'The AI couldn’t produce a valid page this time. Please try again.', 502, true);
}
