export const LOCAL_SOURCE_MAX_BYTES = 24 * 1024 * 1024;
export const LOCAL_SOURCE_MAX_DURATION_MS = 300_000;
export const LOCAL_SOURCE_SAMPLE_RATE = 16_000 as const;

export type DecodedSourceAudio = {
  pcm: Float32Array;
  durationMs: number;
  sampleRate: typeof LOCAL_SOURCE_SAMPLE_RATE;
};

type DecodeWorkerRequest = {
  type: 'decode';
  requestId: string;
  file: File;
};

type DecodeWorkerResponse =
  | {
      type: 'decoded';
      requestId: string;
      pcm: ArrayBuffer;
      durationMs: number;
      sampleRate: number;
    }
  | {
      type: 'error';
      requestId: string;
      code: string;
      message: string;
    };

export type SourceAudioPrepWorkerLike = {
  postMessage(message: DecodeWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<DecodeWorkerResponse>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<DecodeWorkerResponse>) => void): void;
  terminate(): void;
};

type WorkerFactory = () => SourceAudioPrepWorkerLike;

export class SourceAudioPreparationError extends Error {
  readonly code = 'LOCAL_SOURCE_DECODE_FAILED' as const;

  constructor(message = 'Browser source audio decode failed.') {
    super(message);
    this.name = 'SourceAudioPreparationError';
  }
}

function failDecode(message?: string): never {
  throw new SourceAudioPreparationError(message);
}

function defaultWorkerFactory(): SourceAudioPrepWorkerLike {
  return new Worker(
    new URL('./sourceAudioPrep.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as SourceAudioPrepWorkerLike;
}

function requestDecode(
  worker: SourceAudioPrepWorkerLike,
  request: DecodeWorkerRequest,
): Promise<Exclude<DecodeWorkerResponse, { type: 'error' }>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<DecodeWorkerResponse>) => {
      const response = event.data;
      if (!response || response.requestId !== request.requestId) return;
      worker.removeEventListener('message', onMessage);
      if (response.type === 'error') {
        reject(new SourceAudioPreparationError(response.message || undefined));
        return;
      }
      resolve(response);
    };

    worker.addEventListener('message', onMessage);
    worker.postMessage(request);
  });
}

export async function decodeSourceAudio(
  file: File,
  workerFactory: WorkerFactory = defaultWorkerFactory,
): Promise<DecodedSourceAudio> {
  if (!(file instanceof Blob) || file.size <= 0 || file.size > LOCAL_SOURCE_MAX_BYTES) {
    failDecode('Source media is unavailable or exceeds the browser-local size boundary.');
  }

  const worker = workerFactory();
  try {
    const response = await requestDecode(worker, {
      type: 'decode',
      requestId: 'local-source-decode-1',
      file,
    });

    const durationMs = Math.round(response.durationMs);
    if (
      response.type !== 'decoded'
      || !Number.isFinite(durationMs)
      || durationMs <= 0
      || durationMs > LOCAL_SOURCE_MAX_DURATION_MS
      || response.sampleRate !== LOCAL_SOURCE_SAMPLE_RATE
      || !(response.pcm instanceof ArrayBuffer)
      || response.pcm.byteLength === 0
      || response.pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
    ) {
      failDecode('Decoded source audio does not satisfy the browser-local PCM contract.');
    }

    return {
      pcm: new Float32Array(response.pcm),
      durationMs,
      sampleRate: LOCAL_SOURCE_SAMPLE_RATE,
    };
  } catch (error) {
    if (error instanceof SourceAudioPreparationError) throw error;
    failDecode();
  } finally {
    worker.terminate();
  }
}
