export type Stage = 'clarify' | 'confirm' | 'building' | 'live' | 'failed';

export interface Me {
  identity: { kind: 'guest' | 'user'; name: string | null; email: string | null; image: string | null };
  providers: string[];
  limits: { projects: number; used: number; memoMaxSeconds: number };
  host: string;
}
export interface Conv { id: string; title: string; stage: Stage; slug: string | null; url: string | null; error: string | null; createdAt: number; updatedAt: number }
export type Ui =
  | { type: 'chips'; choices: string[] }
  | { type: 'slug'; suggestion?: string }
  | { type: 'confirm'; slug: string }
  | { type: 'live'; url: string; slug: string }
  | { type: 'error'; code: string; retryable: boolean; canResume: boolean }
  | { type: 'revise' };
export interface Msg { id: string; role: 'user' | 'assistant'; content: string; ui: Ui | null; createdAt: number }
export interface Img { id: string; filename: string; role: string; caption: string | null; bytes: number }
export interface Pending { id: string; blob: Blob; previewUrl: string; role: string; name: string }
export interface StageItem { id: string; label: string; detail?: string }
export interface Progress { items: StageItem[]; waiting: string | null; startedAt: number; generic: boolean }

export const state = {
  me: null as Me | null,
  convs: [] as Conv[],
  active: null as Conv | null,
  messages: [] as Msg[],
  images: [] as Img[],
  draft: '',
  pending: [] as Pending[],
  sending: false,
  progress: null as Progress | null,
  rec: { mode: 'idle' as 'idle' | 'recording' | 'transcribing', seconds: 0 },
  slug: { value: '', status: 'idle' as 'idle' | 'checking' | 'ok' | 'bad', reason: '' },
  editingName: false,
  sidebarOpen: false,
  signInOpen: false,
  signInNote: '',
  installEvent: null as null | { prompt(): Promise<void> },
  online: true,
  speak: false,
};
