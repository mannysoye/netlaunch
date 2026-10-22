import { esc, fmtTime, md } from '../lib/dom.ts';
import { state } from '../state.ts';
import type { Conv, Msg, Progress, Ui } from '../state.ts';
import { icon } from './icons.ts';

const host = (): string => state.me?.host ?? location.host;
const STAGE_ORDER = ['checking', 'thinking', 'writing', 'repairing', 'validating', 'mobile', 'uploading', 'verifying'];
export const MICRO_COPY = [
  'Choosing a color palette…', 'Laying out your sections…', 'Writing the copy…',
  'Styling for phones and desktops…', 'Adding the finishing touches…', 'Polishing the details…',
];

/* ------------------------------- sidebar ------------------------------- */
const dot = (s: Conv['stage']) =>
  `<span class="mt-1.5 size-2 shrink-0 rounded-full ${s === 'live' ? 'bg-emerald-500' : s === 'building' ? 'animate-pulse bg-amber-400' : s === 'failed' ? 'bg-red-500' : 'bg-line-strong'}" title="${s}"></span>`;

export function sidebarView(): string {
  const items = state.convs.map((c) => `
    <div class="group flex items-start gap-1 rounded-xl pr-1 ${state.active?.id === c.id ? 'bg-brand-400/30' : 'hover:bg-surface-2'}">
      <button data-act="open" data-id="${esc(c.id)}" class="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left" ${state.active?.id === c.id ? 'aria-current="true"' : ''}>
        ${dot(c.stage)}
        <span class="min-w-0"><span class="block truncate text-sm font-medium">${esc(c.title)}</span>
        <span class="block truncate text-xs text-mute">${c.slug ? esc(host() + '/' + c.slug) : c.stage === 'building' ? 'Building…' : 'Draft'}</span></span>
      </button>
      <button data-act="delete" data-id="${esc(c.id)}" class="icon-btn mt-1 !size-8 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100" aria-label="Delete ${esc(c.title)}">${icon.trash('size-4')}</button>
    </div>`).join('');

  const me = state.me;
  const account = !me ? '' : me.identity.kind === 'user'
    ? `<div class="flex items-center gap-3">
         ${me.identity.image ? `<img src="${esc(me.identity.image)}" alt="" referrerpolicy="no-referrer" class="size-9 rounded-full bg-surface-2" />` : `<div class="grid size-9 place-items-center rounded-full bg-surface-2 text-sm font-semibold">${esc((me.identity.name ?? me.identity.email ?? '?').slice(0, 1).toUpperCase())}</div>`}
         <div class="min-w-0 flex-1"><p class="truncate text-sm font-medium">${esc(me.identity.name ?? 'Signed in')}</p><p class="truncate text-xs text-mute">${esc(me.identity.email ?? '')}</p></div>
         <button data-act="signout" class="btn btn-ghost !px-3 !py-1.5 text-xs">Sign out</button>
       </div>`
    : `<p class="text-sm font-medium">Guest mode</p>
       <p class="mt-0.5 text-xs text-mute">Guests get 1 project. ${me.providers.length ? 'Sign in for more.' : ''}</p>
       ${me.providers.length ? `<button data-act="signin" class="btn btn-ghost mt-3 w-full">Sign in or create account</button>` : ''}`;

  return `
  <div class="flex h-full flex-col">
    <div class="safe-t flex items-center gap-2.5 px-4 pt-4">
      <img src="/icons/icon-192.png" alt="" class="size-8 rounded-lg" width="32" height="32" />
      <span class="text-lg font-bold tracking-tight">NetLaunch</span>
      <button data-act="close-sidebar" class="icon-btn ml-auto md:hidden" aria-label="Close menu">${icon.close()}</button>
    </div>
    <button data-act="new" class="btn btn-primary mx-3 mt-4">${icon.plus('size-4')} New site</button>
    <nav class="mt-3 flex-1 space-y-0.5 overflow-y-auto px-2" aria-label="Your projects">
      ${items || '<p class="px-3 py-6 text-center text-sm text-mute">Your projects will show up here.</p>'}
    </nav>
    <div class="border-t border-line p-3 safe-b">
      ${state.installEvent ? `<button data-act="install" class="btn btn-ghost mb-3 w-full">${icon.download('size-4')} Install app</button>` : ''}
      ${account}
    </div>
  </div>`;
}

/* -------------------------------- header -------------------------------- */
export function headerView(): string {
  const c = state.active;
  const pill = !c ? '' : c.stage === 'live'
    ? `<a href="${esc(c.url ?? '#')}" target="_blank" rel="noopener" class="hidden items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-500/25 sm:inline-flex">● Live ${icon.external('size-3.5')}</a>`
    : `<span class="hidden rounded-full bg-surface-2 px-3 py-1 text-xs text-mute sm:inline">${c.stage === 'building' ? 'Building…' : 'Draft'}</span>`;
  return `
  <header class="safe-t flex items-center gap-2 border-b border-line bg-canvas/80 px-2 py-2 backdrop-blur">
    <button data-act="open-sidebar" class="icon-btn md:hidden" aria-label="Open menu">${icon.menu()}</button>
    <h2 class="min-w-0 flex-1 truncate px-1 text-sm font-semibold">${esc(c?.title ?? 'NetLaunch')}</h2>
    ${pill}
    ${'speechSynthesis' in window ? `<button data-act="speak" class="icon-btn ${state.speak ? '!text-brand-ink' : ''}" aria-pressed="${state.speak}" aria-label="Read replies aloud" title="Read replies aloud">${icon.volume()}</button>` : ''}
  </header>
  ${state.online ? '' : '<div class="bg-amber-400/25 px-4 py-2 text-center text-sm text-amber-800">You’re offline. Reconnect to keep building.</div>'}`;
}

/* ------------------------------- messages ------------------------------- */
function slugCard(suggestion?: string): string {
  const v = state.slug.value || suggestion || '';
  return `
  <div class="card mt-3" data-slug-card data-suggestion="${esc(suggestion ?? '')}">
    <label for="slug-input" class="text-xs font-medium text-mute">Page name</label>
    <div class="mt-1.5 flex items-center rounded-xl border border-line-strong bg-canvas focus-within:border-brand-500">
      <span class="select-none pl-3 text-sm text-mute">${esc(host())}/</span>
      <input id="slug-input" data-slug-input value="${esc(v)}" maxlength="40" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" inputmode="url"
        class="min-w-0 flex-1 bg-transparent px-1 py-3 text-base outline-none placeholder:text-mute/70" placeholder="my-site" aria-describedby="slug-status" />
    </div>
    <p id="slug-status" data-slug-status class="mt-2 min-h-5 text-sm text-mute" aria-live="polite"></p>
    <button data-act="use-slug" data-slug-btn class="btn btn-primary mt-2 w-full" disabled>Use this name</button>
  </div>`;
}

function liveCard(u: Extract<Ui, { type: 'live' }>): string {
  const label = u.url.replace(/^https?:\/\//, '');
  return `
  <div class="card mt-3 flex items-center gap-1 !border-emerald-500/30 !bg-emerald-50 !p-2 pl-4">
    <a href="${esc(u.url)}/" target="_blank" rel="noopener" class="min-w-0 flex-1 truncate font-semibold text-emerald-700 hover:underline">${esc(label)}</a>
    <button data-act="copy" data-url="${esc(u.url)}" class="icon-btn" aria-label="Copy link" title="Copy link">${icon.copy()}</button>
    <a href="${esc(u.url)}/" target="_blank" rel="noopener" class="icon-btn" aria-label="Open site" title="Open site">${icon.external()}</a>
    <button data-act="download" data-slug="${esc(u.slug)}" class="icon-btn !bg-brand-400/40 !text-brand-ink hover:!bg-brand-400/70" aria-label="Download site as a .zip" title="Download .zip">${icon.download()}</button>
  </div>`;
}

function widget(m: Msg, isLast: boolean): string {
  const ui = m.ui;
  if (!ui) return '';
  const stage = state.active?.stage;
  switch (ui.type) {
    case 'chips':
      return isLast && stage === 'clarify' && !state.sending
        ? `<div class="mt-3 flex flex-wrap gap-2">${ui.choices.map((c) => `<button data-act="chip" data-text="${esc(c)}" class="chip">${esc(c)}</button>`).join('')}</div>` : '';
    case 'slug':
      return isLast && stage === 'clarify' ? slugCard(ui.suggestion) : '';
    case 'confirm':
      if (!isLast || (stage !== 'confirm' && stage !== 'failed')) return '';
      return `
      <div class="mt-3 flex flex-wrap gap-2">
        <button data-act="build" class="btn btn-primary">🚀 Build &amp; deploy</button>
        <button data-act="change" class="btn btn-ghost">Change something</button>
        <button data-act="rename" class="btn btn-ghost">Rename page</button>
      </div>${state.editingName ? slugCard() : ''}`;
    case 'live':
      return liveCard(ui);
    case 'error':
      return isLast && !state.progress
        ? `<div class="mt-3 flex gap-2"><button data-act="${ui.canResume ? 'resume' : 'build'}" class="btn btn-primary">${ui.canResume ? 'Retry deployment' : 'Try again'}</button></div>` : '';
    default:
      return '';
  }
}

function bubble(m: Msg, isLast: boolean): string {
  if (m.role === 'user') {
    return `<div class="flex justify-end animate-rise"><div class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-400/35 px-4 py-2.5 text-[0.95rem] ring-1 ring-brand-500/50">${esc(m.content)}</div></div>`;
  }
  return `
  <div class="flex gap-2.5 animate-rise">
    <img src="/icons/icon-192.png" alt="" class="mt-0.5 size-7 shrink-0 rounded-lg" width="28" height="28" />
    <div class="min-w-0 max-w-[92%] ${m.ui?.type === 'error' ? 'rounded-2xl bg-red-50 px-4 py-2.5 ring-1 ring-red-200' : ''}">
      <div class="prose-chat break-words text-[0.95rem] leading-relaxed">${md(m.content)}</div>
      ${widget(m, isLast)}
    </div>
  </div>`;
}

export function progressView(p: Progress | null): string {
  if (!p) return '';
  const secs = Math.floor((Date.now() - p.startedAt) / 1000);
  const currentId = p.items.at(-1)?.id;
  const rows = p.generic
    ? `<li class="flex items-center gap-3 text-sm">${icon.spinner('size-4 text-brand-ink')} Your site is still being built. This page will update when it’s ready…</li>`
    : STAGE_ORDER.map((id) => {
        const item = p.items.find((i) => i.id === id);
        if (!item) return '';
        const active = id === currentId;
        const micro = id === 'writing' && active ? `<span class="block text-xs text-mute">${MICRO_COPY[Math.floor(secs / 4) % MICRO_COPY.length]}</span>` : '';
        const detail = id === 'mobile' && item.detail ? `<span class="mt-1 block whitespace-pre-line text-xs text-mute">${esc(item.detail)}</span>` : '';
        return `<li class="flex items-start gap-3 text-sm ${active ? 'text-ink' : 'text-mute'}">
          <span class="mt-0.5 grid size-4 shrink-0 place-items-center">${active ? icon.spinner('size-4 text-brand-ink') : `<span class="text-emerald-600">${icon.check('size-4')}</span>`}</span>
          <span class="min-w-0"><span class="${active ? 'font-medium' : ''}">${esc(item.label)}${active ? '…' : ''}</span>${micro}${detail}</span></li>`;
      }).join('');
  return `
  <div id="progress" class="flex gap-2.5 animate-rise" role="status" aria-live="polite">
    <img src="/icons/icon-192.png" alt="" class="mt-0.5 size-7 shrink-0 rounded-lg" width="28" height="28" />
    <div class="card w-full max-w-md">
      <ul class="space-y-2.5">${rows}</ul>
      ${p.waiting ? `<p class="mt-3 rounded-lg bg-amber-400/25 px-3 py-2 text-xs text-amber-800">${esc(p.waiting)}</p>` : ''}
      <p class="mt-3 text-xs text-mute">${secs}s elapsed · you can leave this tab open</p>
    </div>
  </div>`;
}

export function heroView(): string {
  const examples = ['A portfolio for a photographer', 'Landing page for my coffee shop', 'A wedding invitation site', 'Promo page for my mobile app'];
  return `
  <div class="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-6 py-10 text-center animate-rise">
    <img src="/icons/icon-192.png" alt="" class="size-16 rounded-2xl ring-1 ring-line shadow-lg shadow-brand-500/40" width="64" height="64" />
    <h1 class="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">Deploy ideas at <span class="rounded bg-brand-400/55 px-1 box-decoration-clone">voice speed.</span></h1>
    <p class="mt-4 max-w-md text-balance text-mute">Describe your website by typing or talking. NetLaunch asks a few smart questions, builds it with AI, and publishes it at <span class="font-medium text-ink-soft">${esc(host())}/your-name</span>.</p>
    <button data-act="hero-mic" class="mt-9 grid size-20 place-items-center rounded-full border-2 border-brand-500 bg-brand-400 text-ink shadow-lg shadow-brand-500/40 transition hover:scale-105 hover:bg-brand-300" aria-label="Record a voice memo">${icon.mic('size-8')}</button>
    <p class="mt-3 text-sm text-mute">Tap to record a voice memo (up to 5 min), or type below</p>
    <div class="mt-7 flex flex-wrap justify-center gap-2">${examples.map((e) => `<button data-act="example" data-text="${esc(e)}" class="chip">${esc(e)}</button>`).join('')}</div>
  </div>`;
}

export function messagesView(): string {
  if (!state.active) return heroView();
  const imgs = state.images.length
    ? `<div class="flex items-center gap-2 text-xs text-mute"><span>Attached:</span>${state.images.map((i) => `<img src="/api/conversations/${esc(state.active!.id)}/images/${esc(i.id)}" alt="${esc(i.role)}" title="${esc(i.role)}" class="size-9 rounded-lg object-cover ring-1 ring-line" loading="lazy" />`).join('')}</div>` : '';
  const last = state.messages.length - 1;
  return `<div class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6">${imgs}${state.messages.map((m, i) => bubble(m, i === last)).join('')}${state.sending && !state.progress ? `<div class="flex items-center gap-2 pl-10 text-sm text-mute">${icon.spinner('size-4')} Thinking…</div>` : ''}${progressView(state.progress)}</div>`;
}

/* ------------------------------- composer ------------------------------- */
export function composerView(): string {
  const tray = state.pending.length
    ? `<div class="mb-2 flex gap-2 overflow-x-auto pb-1">${state.pending.map((p) => `
        <div class="relative shrink-0 rounded-xl border border-line-strong bg-surface p-1.5">
          <img src="${p.previewUrl}" alt="${esc(p.name)}" class="size-16 rounded-lg object-cover" />
          <select data-role="${esc(p.id)}" class="mt-1 w-16 rounded border border-line-strong bg-canvas text-xs" aria-label="Image role">
            ${['logo', 'hero', 'gallery', 'other'].map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          <button data-act="remove-image" data-id="${esc(p.id)}" class="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-line-strong text-ink-soft ring-2 ring-canvas hover:bg-red-500 hover:text-white" aria-label="Remove image">${icon.close('size-3')}</button>
        </div>`).join('')}</div>` : '';

  const rec = state.rec;
  const body = rec.mode === 'recording'
    ? `<div class="flex flex-1 items-center gap-3 rounded-3xl border border-red-400 bg-surface px-4 py-2.5">
         <span class="relative grid size-8 place-items-center"><span id="rec-level" class="absolute inset-0 rounded-full bg-red-500/40 transition-transform"></span><span class="relative size-3 rounded-full bg-red-500"></span></span>
         <span class="font-mono text-sm tabular-nums" id="rec-time">${fmtTime(rec.seconds)}</span><span class="text-xs text-mute">/ 5:00</span>
         <span class="ml-auto text-xs text-mute">Recording…</span>
       </div>
       <button data-act="rec-cancel" class="icon-btn" aria-label="Cancel recording">${icon.trash()}</button>
       <button data-act="rec-stop" class="grid size-11 shrink-0 place-items-center rounded-full bg-red-500 text-white animate-ring" aria-label="Stop and transcribe">${icon.stop()}</button>`
    : rec.mode === 'transcribing'
      ? `<div class="flex flex-1 items-center gap-3 rounded-3xl border border-line-strong bg-surface px-4 py-3 text-sm text-mute">${icon.spinner('size-4')} Transcribing your voice memo…</div>`
      : `<button data-act="attach" class="icon-btn" aria-label="Attach images (logo, photos)" title="Attach logo or images">${icon.clip()}</button>
         <textarea id="input" rows="1" maxlength="8000" placeholder="${state.active ? 'Reply, or describe a change…' : 'Describe the website you want…'}" aria-label="Message"
           class="max-h-40 min-h-11 flex-1 resize-none rounded-3xl border border-line-strong bg-surface px-4 py-2.5 text-base outline-none placeholder:text-mute/70 focus:border-brand-500 focus:bg-canvas"></textarea>
         <button data-act="mic" class="icon-btn !bg-surface border border-line-strong !text-brand-ink hover:!border-brand-500 hover:!bg-brand-400/30" aria-label="Record a voice memo" title="Voice memo (up to 5 min)">${icon.mic()}</button>
         <button data-act="send" class="grid size-11 shrink-0 place-items-center rounded-full bg-brand-400 text-ink transition hover:bg-brand-300 disabled:opacity-40" aria-label="Send" ${state.sending || !state.online ? 'disabled' : ''}>${icon.send()}</button>`;
  return `<div class="mx-auto max-w-2xl">${tray}<div class="flex items-end gap-2">${body}</div></div>`;
}

/* -------------------------------- modal -------------------------------- */
export function signInView(): string {
  if (!state.signInOpen) return '';
  const p = state.me?.providers ?? [];
  return `
  <div class="fixed inset-0 z-[70] grid place-items-end bg-ink/30 p-0 backdrop-blur-sm sm:place-items-center sm:p-4" data-act="close-modal" role="dialog" aria-modal="true" aria-labelledby="signin-title">
    <div class="w-full max-w-sm rounded-t-3xl border border-line-strong bg-canvas p-6 shadow-xl shadow-ink/10 safe-b sm:rounded-3xl" data-stop>
      <h2 id="signin-title" class="text-xl font-bold">Create a free account</h2>
      <p class="mt-2 text-sm text-mute">${esc(state.signInNote || 'Save your projects across devices and create more than one site.')}</p>
      <div class="mt-5 space-y-3">
        ${p.includes('github') ? `<button data-act="auth" data-provider="github" class="btn btn-ghost w-full !py-3">${icon.github()} Continue with GitHub</button>` : ''}
        ${p.includes('google') ? `<button data-act="auth" data-provider="google" class="btn btn-ghost w-full !py-3">${icon.google()} Continue with Google</button>` : ''}
        ${p.length ? '' : '<p class="text-sm text-amber-800">Sign-in isn’t set up on this server yet.</p>'}
      </div>
      <button data-act="close-modal" class="mt-4 w-full text-sm text-mute hover:text-ink">Not now</button>
    </div>
  </div>`;
}
