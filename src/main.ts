import { ApiError, api, authPost, sse } from './lib/api.ts';
import { $, esc } from './lib/dom.ts';
import { prepareImage } from './lib/images.ts';
import { Recorder, RecorderError, recordingSupported } from './lib/recorder.ts';
import { downloadSiteZip } from './lib/zip.ts';
import { state } from './state.ts';
import type { Conv, Img, Me, Msg } from './state.ts';
import { composerView, headerView, messagesView, progressView, sidebarView, signInView } from './ui/views.ts';

/* ------------------------------ shell & render ------------------------------ */
const app = $('#app')!;
app.innerHTML = `
  <div class="flex h-full">
    <div id="scrim" class="fixed inset-0 z-30 hidden bg-ink/30 md:hidden" data-act="close-sidebar"></div>
    <aside id="sidebar" class="fixed inset-y-0 left-0 z-40 w-72 -translate-x-full border-r border-line bg-canvas transition-transform duration-200 md:static md:translate-x-0" aria-label="Sidebar"></aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <div id="header"></div>
      <main id="messages" class="min-h-0 flex-1 overflow-y-auto" tabindex="-1" aria-live="polite" aria-label="Conversation"></main>
      <footer id="composer" class="border-t border-line bg-canvas px-3 pt-3 safe-b"></footer>
    </div>
  </div>
  <div id="modal"></div>
  <input id="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />`;

const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 160;

function renderSidebar() {
  q('sidebar').innerHTML = sidebarView();
  q('sidebar').classList.toggle('-translate-x-full', !state.sidebarOpen);
  q('scrim').classList.toggle('hidden', !state.sidebarOpen);
}
const renderHeader = () => { q('header').innerHTML = headerView(); };
function renderMessages(forceScroll = false) {
  const el = q('messages');
  const stick = forceScroll || nearBottom(el);
  el.innerHTML = messagesView();
  if (stick) el.scrollTop = el.scrollHeight;
  hydrateSlugCard();
}
function renderComposer() {
  const had = document.activeElement?.id === 'input';
  q('composer').innerHTML = composerView();
  const input = $<HTMLTextAreaElement>('#input');
  if (input) { input.value = state.draft; autosize(input); if (had) input.focus(); }
}
const renderModal = () => { q('modal').innerHTML = signInView(); };
function renderAll(forceScroll = false) { renderSidebar(); renderHeader(); renderMessages(forceScroll); renderComposer(); renderModal(); }

function autosize(t: HTMLTextAreaElement) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }

/* ---------------------------------- toasts ---------------------------------- */
function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info') {
  const t = document.createElement('div');
  t.className = `pointer-events-auto max-w-md animate-rise rounded-xl px-4 py-2.5 text-sm shadow-lg ring-1 ${kind === 'error' ? 'bg-red-50 text-red-700 ring-red-200' : kind === 'ok' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-ink text-canvas ring-ink/10'}`;
  t.textContent = message;
  q('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

function handleError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === 'limit_guest_projects') { state.signInNote = 'Guests can create one project. Create a free account to start more.'; state.signInOpen = true; renderModal(); return; }
    toast(e.message, 'error');
  } else if (e instanceof RecorderError) {
    if (e.message !== 'cancelled') toast(e.message, 'error');
  } else {
    console.error(e);
    toast('Something unexpected happened. Please try again.', 'error');
  }
}

/* -------------------------------- data helpers -------------------------------- */
interface ConvPayload { conversation: Conv; messages: Msg[]; images?: Img[] }
const upsertConv = (c: Conv) => {
  const i = state.convs.findIndex((x) => x.id === c.id);
  if (i >= 0) state.convs[i] = c; else state.convs.unshift(c);
  state.convs.sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.active?.id === c.id) state.active = c;
};

function speak(text: string) {
  if (!state.speak || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text.replace(/\*\*|`/g, '')));
}

async function openConversation(id: string) {
  const r = await api<ConvPayload>(`/api/conversations/${id}`);
  state.active = r.conversation; state.messages = r.messages; state.images = r.images ?? [];
  state.progress = null; state.editingName = false; state.slug = { value: '', status: 'idle', reason: '' };
  upsertConv(r.conversation);
  state.sidebarOpen = false;
  renderAll(true);
  if (r.conversation.stage === 'building') { state.progress = { items: [], waiting: null, startedAt: Date.now(), generic: true }; renderMessages(true); void pollUntilSettled(id); }
}

async function pollUntilSettled(id: string) {
  for (let i = 0; i < 70; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (state.active?.id !== id) return;
    try {
      const r = await api<ConvPayload>(`/api/conversations/${id}`);
      if (r.conversation.stage !== 'building') {
        state.messages = r.messages; state.images = r.images ?? []; state.progress = null; upsertConv(r.conversation); renderAll(true); return;
      }
    } catch { /* keep polling through blips */ }
  }
  state.progress = null; renderAll();
}

async function ensureConversation() {
  if (state.active) return;
  const r = await api<ConvPayload>('/api/conversations', { method: 'POST' });
  state.active = r.conversation; state.messages = r.messages; state.images = []; upsertConv(r.conversation);
  if (state.me) state.me.limits.used++;
  renderSidebar();
}

/* ---------------------------------- sending ---------------------------------- */
async function uploadPending() {
  const id = state.active!.id;
  for (const p of [...state.pending]) {
    const fd = new FormData();
    fd.append('file', p.blob, p.name); fd.append('role', p.role);
    const r = await api<{ image: Img }>(`/api/conversations/${id}/images`, { body: fd });
    state.images.push(r.image);
    URL.revokeObjectURL(p.previewUrl);
    state.pending = state.pending.filter((x) => x.id !== p.id);
    renderComposer();
  }
}

async function send(textArg?: string) {
  const text = (textArg ?? state.draft).trim();
  if (state.sending || !state.online || (!text && !state.pending.length)) return;
  const content = text || 'I attached some images for the site.';
  const prevDraft = state.draft;
  state.sending = true; state.draft = ''; renderComposer();
  const temp: Msg = { id: 'tmp-' + Date.now(), role: 'user', content, ui: null, createdAt: Date.now() };
  try {
    await ensureConversation();
    state.messages.push(temp); renderAll(true);
    await uploadPending();
    const r = await api<ConvPayload>(`/api/conversations/${state.active!.id}/messages`, { json: { text: content } });
    state.messages = [...state.messages.filter((m) => m.id !== temp.id), ...r.messages];
    upsertConv(r.conversation);
    const last = r.messages.at(-1);
    if (last?.role === 'assistant') speak(last.content);
    state.sending = false; renderAll(true);
    if (last?.ui?.type === 'revise') await startBuild();
  } catch (e) {
    state.messages = state.messages.filter((m) => m.id !== temp.id);
    if (!state.draft) state.draft = prevDraft || text;
    handleError(e);
  } finally {
    state.sending = false; renderAll(true);
  }
}

/* ------------------------------ build + progress ------------------------------ */
let ticker = 0;

function updateProgressDom() {
  const node = $('#progress');
  if (node) node.outerHTML = progressView(state.progress);
  const el = q('messages');
  if (nearBottom(el)) el.scrollTop = el.scrollHeight;
}

async function startBuild(resume = false) {
  const id = state.active?.id;
  if (!id || state.progress) return;
  state.progress = { items: [], waiting: null, startedAt: Date.now(), generic: false };
  if (state.active) state.active.stage = 'building';
  renderAll(true);
  clearInterval(ticker); ticker = window.setInterval(updateProgressDom, 1000);
  try {
    for await (const ev of sse(`/api/conversations/${id}/build`, { resume })) {
      const p = state.progress;
      if (!p) break;
      if (ev.event === 'stage') {
        if (ev.data.id === 'waiting') p.waiting = ev.data.label;
        else {
          p.waiting = null;
          p.items = p.items.filter((i) => i.id !== ev.data.id);
          p.items.push({ id: ev.data.id, label: ev.data.label, detail: ev.data.detail });
        }
        updateProgressDom();
      } else if (ev.event === 'done') {
        state.messages.push(ev.data.message); upsertConv(ev.data.conversation);
        speak(ev.data.message.content);
      } else if (ev.event === 'failed') {
        if (ev.data.message) state.messages.push(ev.data.message);
        if (ev.data.conversation) upsertConv(ev.data.conversation);
        toast(ev.data.error?.message ?? 'The build failed.', 'error');
      }
    }
  } catch (e) {
    if (e instanceof ApiError && e.status > 0) handleError(e);
    else {
      // The stream dropped (phone locked, flaky network). The server keeps building: fall back to polling.
      state.progress = { items: [], waiting: null, startedAt: Date.now(), generic: true };
      renderMessages(true); clearInterval(ticker);
      await pollUntilSettled(id);
      return;
    }
  } finally {
    clearInterval(ticker);
  }
  state.progress = null;
  // pick up the authoritative conversation state (stage may have changed on failure)
  try { const r = await api<ConvPayload>(`/api/conversations/${id}`); upsertConv(r.conversation); state.images = r.images ?? state.images; } catch { /* non-fatal */ }
  renderAll(true);
}

/* ---------------------------------- page name ---------------------------------- */
let slugTimer = 0;
let slugSeq = 0;

function setSlugStatus(status: typeof state.slug.status, reason = '') {
  state.slug.status = status; state.slug.reason = reason;
  const s = $('[data-slug-status]'); const b = $<HTMLButtonElement>('[data-slug-btn]');
  if (s) {
    s.className = `mt-2 min-h-5 text-sm ${status === 'ok' ? 'text-emerald-600' : status === 'bad' ? 'text-red-600' : 'text-mute'}`;
    s.textContent = status === 'checking' ? 'Checking…' : status === 'ok' ? `✓ ${reason}` : reason;
  }
  if (b) b.disabled = status !== 'ok';
}

async function checkSlug(value: string) {
  const seq = ++slugSeq;
  state.slug.value = value;
  if (value.trim().length < 3) { setSlugStatus('idle', 'Use at least 3 letters or numbers.'); return; }
  setSlugStatus('checking');
  try {
    const r = await api<{ available: boolean; slug: string; reason: string | null }>(`/api/slug/check?name=${encodeURIComponent(value)}&conversation=${state.active?.id ?? ''}`);
    if (seq !== slugSeq) return; // a newer keystroke superseded this check
    setSlugStatus(r.available ? 'ok' : 'bad', r.available ? `${state.me?.host ?? location.host}/${r.slug} is available` : (r.reason ?? 'Not available'));
    if (r.available) state.slug.value = r.slug;
  } catch (e) {
    if (seq === slugSeq) setSlugStatus('idle', e instanceof ApiError ? e.message : 'Couldn’t check right now.');
  }
}

function hydrateSlugCard() {
  const input = $<HTMLInputElement>('[data-slug-input]');
  if (input && input.value) void checkSlug(input.value);
}

async function useSlug() {
  const input = $<HTMLInputElement>('[data-slug-input]');
  if (!input || !state.active || state.slug.status !== 'ok') return;
  const btn = $<HTMLButtonElement>('[data-slug-btn]'); if (btn) btn.disabled = true;
  try {
    const r = await api<ConvPayload & { slug: string }>(`/api/conversations/${state.active.id}/slug`, { json: { slug: input.value } });
    state.messages.push(...r.messages); upsertConv(r.conversation);
    state.editingName = false; state.slug = { value: '', status: 'idle', reason: '' };
    const last = r.messages.at(-1); if (last) speak(last.content);
    renderAll(true);
  } catch (e) {
    handleError(e);
    if (e instanceof ApiError && (e.code === 'slug_taken' || e.code === 'slug_invalid')) setSlugStatus('bad', e.message);
  }
}

/* ----------------------------------- voice ----------------------------------- */
const recorder = new Recorder({
  onTick: (s) => { state.rec.seconds = s; const t = $('#rec-time'); if (t) t.textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; },
  onLevel: (l) => { const el = $('#rec-level'); if (el) el.style.transform = `scale(${1 + l * 1.4})`; },
  onAutoStop: () => { toast('Reached the 5-minute limit. Transcribing what you recorded.', 'info'); void stopAndTranscribe(); },
});

async function startRecording() {
  if (state.rec.mode !== 'idle') return;
  if (!recordingSupported()) { toast('Voice memos need HTTPS and a browser that supports recording (Chrome, Edge, Safari, Firefox).', 'error'); return; }
  try {
    await recorder.start();
    state.rec = { mode: 'recording', seconds: 0 }; renderComposer();
  } catch (e) { handleError(e); }
}

async function stopAndTranscribe() {
  if (state.rec.mode !== 'recording') return;
  state.rec.mode = 'transcribing'; renderComposer();
  try {
    const blob = await recorder.stop();
    const fd = new FormData(); fd.append('audio', blob, 'memo');
    const r = await api<{ text: string }>('/api/voice/transcribe', { body: fd });
    state.draft = (state.draft ? state.draft.trimEnd() + ' ' : '') + r.text;
    toast('Transcribed. Edit it if you like, then press send.', 'ok');
  } catch (e) { handleError(e); }
  state.rec = { mode: 'idle', seconds: 0 }; renderComposer();
  $<HTMLTextAreaElement>('#input')?.focus();
}

function cancelRecording() { recorder.cancel(); state.rec = { mode: 'idle', seconds: 0 }; renderComposer(); }

/* --------------------------------- attachments --------------------------------- */
async function addFiles(files: FileList | null) {
  if (!files?.length) return;
  const room = 6 - state.images.length - state.pending.length;
  if (room <= 0) { toast('You can attach up to 6 images.', 'error'); return; }
  for (const f of [...files].slice(0, room)) {
    try {
      const blob = await prepareImage(f);
      const ext = blob.type.split('/')[1] ?? 'img';
      const first = state.pending.length + state.images.length === 0;
      state.pending.push({ id: crypto.randomUUID(), blob, previewUrl: URL.createObjectURL(blob), role: first ? 'logo' : 'gallery', name: `${f.name.replace(/\.[^.]+$/, '')}.${ext}` });
    } catch (e) { toast((e as Error).message, 'error'); }
  }
  renderComposer();
}

/* ----------------------------------- actions ----------------------------------- */
type Action = (el: HTMLElement, ev: Event) => void | Promise<void>;
const actions: Record<string, Action> = {
  'open-sidebar': () => { state.sidebarOpen = true; renderSidebar(); },
  'close-sidebar': () => { state.sidebarOpen = false; renderSidebar(); },
  new: async () => {
    state.sidebarOpen = false;
    try {
      const r = await api<ConvPayload>('/api/conversations', { method: 'POST' });
      state.active = r.conversation; state.messages = r.messages; state.images = []; state.progress = null; state.editingName = false;
      upsertConv(r.conversation); renderAll(true); $<HTMLTextAreaElement>('#input')?.focus();
    } catch (e) { renderSidebar(); handleError(e); }
  },
  open: (el) => openConversation(el.dataset.id!),
  delete: async (el) => {
    const c = state.convs.find((x) => x.id === el.dataset.id);
    if (!c || !confirm(`Delete “${c.title}”?${c.slug ? ' Its live site will be taken offline.' : ''}`)) return;
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    state.convs = state.convs.filter((x) => x.id !== c.id);
    if (state.active?.id === c.id) { state.active = null; state.messages = []; state.images = []; }
    toast('Deleted.', 'ok'); renderAll();
  },
  send: () => send(),
  chip: (el) => send(el.dataset.text),
  example: (el) => { state.draft = el.dataset.text ?? ''; renderComposer(); $<HTMLTextAreaElement>('#input')?.focus(); },
  mic: startRecording, 'hero-mic': startRecording,
  'rec-stop': stopAndTranscribe, 'rec-cancel': cancelRecording,
  attach: () => q<HTMLInputElement>('file').click(),
  'remove-image': (el) => {
    const p = state.pending.find((x) => x.id === el.dataset.id); if (p) URL.revokeObjectURL(p.previewUrl);
    state.pending = state.pending.filter((x) => x.id !== el.dataset.id); renderComposer();
  },
  'use-slug': useSlug,
  rename: () => { state.editingName = true; renderMessages(true); },
  change: () => { const i = $<HTMLTextAreaElement>('#input'); if (i) { i.placeholder = 'What should change?'; i.focus(); } },
  build: () => startBuild(false),
  resume: () => startBuild(true),
  copy: async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.url!); toast('Link copied.', 'ok'); } catch { toast(el.dataset.url!, 'info'); }
  },
  download: async (el) => {
    toast('Preparing your .zip…');
    try { await downloadSiteZip(el.dataset.slug!, state.images.map((i) => i.filename)); toast('Downloaded.', 'ok'); }
    catch (e) { toast((e as Error).message || 'Download failed.', 'error'); }
  },
  speak: () => {
    state.speak = !state.speak;
    try { localStorage.setItem('nl_speak', state.speak ? '1' : '0'); } catch { /* storage may be blocked */ }
    if (!state.speak && 'speechSynthesis' in window) speechSynthesis.cancel();
    renderHeader();
  },
  signin: () => { state.signInNote = ''; state.signInOpen = true; renderModal(); },
  'close-modal': (el, ev) => {
    // The overlay itself carries the action; ignore clicks that land inside the dialog panel.
    if (el.hasAttribute('role') && (ev.target as HTMLElement).closest('[data-stop]')) return;
    state.signInOpen = false; renderModal();
  },
  auth: async (el) => { try { await authPost('signin', el.dataset.provider); } catch (e) { handleError(e); } },
  signout: async () => { try { await authPost('signout'); } catch (e) { handleError(e); } },
  install: async () => { await state.installEvent?.prompt(); state.installEvent = null; renderSidebar(); },
};

document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  const fn = el && actions[el.dataset.act!];
  if (!el || !fn) return;
  Promise.resolve(fn(el, ev)).catch(handleError);
});

document.addEventListener('input', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === 'input') { state.draft = (t as HTMLTextAreaElement).value; autosize(t as HTMLTextAreaElement); }
  else if (t.matches('[data-slug-input]')) {
    clearTimeout(slugTimer);
    const v = (t as HTMLInputElement).value;
    setSlugStatus('checking');
    slugTimer = window.setTimeout(() => void checkSlug(v), 350);
  }
});
document.addEventListener('change', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === 'file') { void addFiles((t as HTMLInputElement).files); (t as HTMLInputElement).value = ''; }
  else if (t.matches('select[data-role]')) { const p = state.pending.find((x) => x.id === (t as HTMLElement).dataset.role); if (p) p.role = (t as HTMLSelectElement).value; }
});
document.addEventListener('keydown', (ev) => {
  const t = ev.target as HTMLElement;
  if (ev.key === 'Enter' && !ev.shiftKey && t.id === 'input' && matchMedia('(pointer: fine)').matches) { ev.preventDefault(); void send(); }
  else if (ev.key === 'Enter' && t.matches('[data-slug-input]')) { ev.preventDefault(); void useSlug(); }
  else if (ev.key === 'Escape') { if (state.signInOpen) { state.signInOpen = false; renderModal(); } else if (state.sidebarOpen) { state.sidebarOpen = false; renderSidebar(); } }
});

/* ------------------------------------ PWA ------------------------------------ */
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvent = e as unknown as { prompt(): Promise<void> }; renderSidebar(); });
window.addEventListener('appinstalled', () => { state.installEvent = null; renderSidebar(); });
window.addEventListener('online', () => { state.online = true; renderHeader(); renderComposer(); });
window.addEventListener('offline', () => { state.online = false; renderHeader(); renderComposer(); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* app works without it */ }); });
}

/* ------------------------------------ boot ------------------------------------ */
async function boot() {
  state.online = navigator.onLine;
  try { state.speak = localStorage.getItem('nl_speak') === '1'; } catch { /* ignore */ }
  renderAll();
  const err = new URLSearchParams(location.search).get('error');
  if (err) { toast('Sign-in didn’t complete. Please try again.', 'error'); history.replaceState(null, '', '/'); }
  try {
    state.me = await api<Me>('/api/me');
    const { conversations } = await api<{ conversations: Conv[] }>('/api/conversations');
    state.convs = conversations;
    renderSidebar();
    const first = conversations[0];
    if (first) await openConversation(first.id); else renderAll();
  } catch (e) {
    $('#messages')!.innerHTML = `<div class="mx-auto max-w-md px-6 py-20 text-center"><h1 class="text-xl font-bold">We couldn’t load NetLaunch</h1><p class="mt-2 text-mute">${esc(e instanceof ApiError ? e.message : 'Please check your connection.')}</p><button class="btn btn-primary mt-6" onclick="location.reload()">Try again</button></div>`;
  }
}
void boot();
