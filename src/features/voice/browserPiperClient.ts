import type { PiperWorkerRequest, PiperWorkerResponse } from './browserPiperProtocol';

export type PiperWorkerLike = {
  postMessage: (message: PiperWorkerRequest) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<PiperWorkerResponse>) => void) => void;
  removeEventListener: (type: 'message', listener: (event: MessageEvent<PiperWorkerResponse>) => void) => void;
  terminate: () => void;
};

export type PiperWorkerFactory = () => PiperWorkerLike;

export class BrowserPiperError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserPiperError';
  }
}

function defaultWorkerFactory(): PiperWorkerLike {
  return new Worker(new URL('./browserPiper.worker.ts', import.meta.url), { type: 'module' }) as unknown as PiperWorkerLike;
}

export function browserPiperAvailable(): boolean {
  return typeof Worker !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.storage?.getDirectory === 'function';
}

type PendingRequest = {
  requestId: string;
  resolve: (pcm: Uint8Array) => void;
  reject: (error: Error) => void;
};

export class BrowserPiperClient {
  private worker: PiperWorkerLike | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private pending: PendingRequest | null = null;
  private progress: ((loaded?: number, total?: number) => void) | undefined;
  private failed: Error | null = null;
  private disposed = false;
  private sequence = 0;
  private busy = false;

  constructor(private readonly workerFactory: PiperWorkerFactory = defaultWorkerFactory) {}

  private readonly onMessage = (event: MessageEvent<PiperWorkerResponse>) => {
    const message = event.data;
    if (message.type === 'progress') {
      this.progress?.(message.loaded, message.total);
      return;
    }
    if (message.type === 'ready') {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (message.type === 'error') {
      const error = new BrowserPiperError(message.code, message.message);
      if (!message.requestId) {
        this.failed = error;
        this.readyReject?.(error);
        this.readyResolve = null;
        this.readyReject = null;
        return;
      }
      if (this.pending?.requestId === message.requestId) {
        const pending = this.pending;
        this.pending = null;
        pending.reject(error);
      }
      return;
    }
    if (message.type === 'result' && this.pending?.requestId === message.requestId) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve(new Uint8Array(message.pcm));
    }
  };

  private ensureWorker(): PiperWorkerLike {
    if (this.disposed) throw new BrowserPiperError('PIPER_DISPOSED', 'Browser Piper client has been disposed.');
    if (!this.worker) {
      this.worker = this.workerFactory();
      this.worker.addEventListener('message', this.onMessage);
    }
    return this.worker;
  }

  private ensureReady(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    if (!this.readyPromise) {
      const worker = this.ensureWorker();
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
      worker.postMessage({ type: 'init' });
    }
    return this.readyPromise;
  }

  async synthesize(
    text: string,
    onProgress?: (loaded?: number, total?: number) => void,
  ): Promise<Uint8Array> {
    if (!text.trim()) throw new BrowserPiperError('PIPER_TEXT_EMPTY', 'Vietnamese voice text cannot be empty.');
    if (this.busy) throw new BrowserPiperError('PIPER_BUSY', 'Browser Piper is already synthesizing a segment.');
    this.busy = true;
    this.progress = onProgress;
    try {
      await this.ensureReady();
      if (this.failed) throw this.failed;
      const worker = this.ensureWorker();
      const requestId = `piper-${++this.sequence}`;
      const pcm = await new Promise<Uint8Array>((resolve, reject) => {
        this.pending = { requestId, resolve, reject };
        worker.postMessage({ type: 'synthesize', requestId, text });
      });
      return pcm;
    } finally {
      this.pending = null;
      this.progress = undefined;
      this.busy = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = new BrowserPiperError('PIPER_DISPOSED', 'Browser Piper client has been disposed.');
    this.readyReject?.(error);
    this.pending?.reject(error);
    if (this.worker) {
      this.worker.removeEventListener('message', this.onMessage);
      this.worker.terminate();
    }
    this.worker = null;
    this.pending = null;
    this.readyResolve = null;
    this.readyReject = null;
  }
}
