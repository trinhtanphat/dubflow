import type { PiperWorkerRequest, PiperWorkerResponse } from './browserPiperProtocol';

export type PiperWorkerLike = {
  postMessage(message: PiperWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<PiperWorkerResponse>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<PiperWorkerResponse>) => void): void;
  terminate(): void;
};

type WorkerFactory = () => PiperWorkerLike;
type Progress = (loaded?: number, total?: number) => void;

type ActiveRequest = {
  requestId: string;
  resolve: (pcm: Uint8Array) => void;
  reject: (error: Error) => void;
  progress?: Progress;
};

export function browserPiperAvailable(): boolean {
  return typeof Worker !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.storage?.getDirectory === 'function';
}

export class BrowserPiperError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserPiperError';
  }
}

export class BrowserPiperClient {
  private worker: PiperWorkerLike | null = null;
  private initPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private active: ActiveRequest | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(
    private readonly workerFactory: WorkerFactory = () => new Worker(
      new URL('./browserPiper.worker.ts', import.meta.url),
      { type: 'module' },
    ) as unknown as PiperWorkerLike,
  ) {}

  private readonly onMessage = (event: MessageEvent<PiperWorkerResponse>) => {
    const message = event.data;
    if (message.type === 'progress') {
      this.active?.progress?.(message.loaded, message.total);
      return;
    }
    if (message.type === 'ready') {
      this.initResolve?.();
      this.initResolve = null;
      this.initReject = null;
      return;
    }
    if (message.type === 'error') {
      const error = new BrowserPiperError(message.code, message.message || message.code);
      if (this.initReject && !message.requestId) {
        this.initReject(error);
        this.initResolve = null;
        this.initReject = null;
        this.initPromise = null;
        return;
      }
      if (this.active && (!message.requestId || message.requestId === this.active.requestId)) {
        const active = this.active;
        this.active = null;
        active.reject(error);
      }
      return;
    }
    if (message.type === 'result' && this.active && message.requestId === this.active.requestId) {
      const active = this.active;
      this.active = null;
      active.resolve(new Uint8Array(message.pcm));
    }
  };

  private ensureWorker(): PiperWorkerLike {
    if (this.disposed) throw new Error('Browser Piper client is disposed.');
    if (!this.worker) {
      this.worker = this.workerFactory();
      this.worker.addEventListener('message', this.onMessage);
    }
    return this.worker;
  }

  private ensureReady(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const worker = this.ensureWorker();
    this.initPromise = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    worker.postMessage({ type: 'init' });
    return this.initPromise;
  }

  synthesize(text: string, progress?: Progress): Promise<Uint8Array> {
    if (!text.trim()) return Promise.reject(new Error('Piper synthesis text is empty.'));
    if (this.active) return Promise.reject(new Error('Browser Piper synthesis is already active.'));
    if (this.disposed) return Promise.reject(new Error('Browser Piper client is disposed.'));

    const requestId = `piper-${++this.sequence}`;
    return new Promise<Uint8Array>((resolve, reject) => {
      this.active = { requestId, resolve, reject, progress };
      this.ensureReady().then(() => {
        if (!this.active || this.active.requestId !== requestId) return;
        this.ensureWorker().postMessage({ type: 'synthesize', requestId, text });
      }).catch((error: unknown) => {
        if (!this.active || this.active.requestId !== requestId) return;
        const active = this.active;
        this.active = null;
        active.reject(error instanceof Error ? error : new Error('Piper initialization failed.'));
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.active) {
      const active = this.active;
      this.active = null;
      active.reject(new Error('Browser Piper client was disposed.'));
    }
    if (this.worker) {
      this.worker.removeEventListener('message', this.onMessage);
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    this.initResolve = null;
    this.initReject = null;
  }
}
