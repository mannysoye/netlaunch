export const MAX_SECONDS = 300; // 5 minutes

export class RecorderError extends Error {}

const MIME_PREFERENCE = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

export interface RecorderHooks {
  onTick(seconds: number): void;
  onLevel(level: number): void; // 0..1
  onAutoStop(): void; // fired when the 5-minute limit is hit
}

/** Voice-memo recorder: MediaRecorder -> Blob, with a timer, input level meter and hard 5-minute cap. */
export class Recorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private timer = 0;
  private raf = 0;
  private ctx: AudioContext | null = null;
  private startedAt = 0;
  private hooks: RecorderHooks;
  private cancelled = false;

  constructor(hooks: RecorderHooks) { this.hooks = hooks; }

  async start(): Promise<void> {
    if (!recordingSupported()) throw new RecorderError('Voice memos need a secure (HTTPS) page and a browser that supports recording.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new RecorderError('Microphone access is blocked. Allow it in your browser’s site settings and try again.');
      if (name === 'NotFoundError') throw new RecorderError('No microphone was found on this device.');
      throw new RecorderError('Couldn’t start the microphone. Is another app using it?');
    }
    const mimeType = MIME_PREFERENCE.find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
    this.chunks = []; this.cancelled = false;
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.startedAt = Date.now();
    this.timer = window.setInterval(() => {
      const s = (Date.now() - this.startedAt) / 1000;
      this.hooks.onTick(Math.min(s, MAX_SECONDS));
      if (s >= MAX_SECONDS) this.hooks.onAutoStop();
    }, 250);
    this.meter();
  }

  private meter() {
    try {
      this.ctx = new AudioContext();
      const analyser = this.ctx.createAnalyser(); analyser.fftSize = 256;
      this.ctx.createMediaStreamSource(this.stream!).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0; for (const v of data) sum += ((v - 128) / 128) ** 2;
        this.hooks.onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* meter is cosmetic */ }
  }

  private cleanup() {
    clearInterval(this.timer); cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.ctx = null; this.stream = null;
  }

  /** Stops and resolves with the recording. */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec || rec.state === 'inactive') { this.cleanup(); reject(new RecorderError('Nothing was recorded.')); return; }
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.cleanup();
        this.cancelled ? reject(new RecorderError('cancelled')) : resolve(blob);
      };
      rec.stop();
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.rec && this.rec.state !== 'inactive') { this.rec.onstop = () => this.cleanup(); this.rec.stop(); } else this.cleanup();
  }
}
