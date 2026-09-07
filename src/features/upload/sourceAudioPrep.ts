export const PREPARED_ASR_CHUNK_DURATION_MS = 300_000;
export const DIRECT_ASR_MAX_BYTES = 24 * 1024 * 1024;

export type PreparedAsrChunk = {
  index: number;
  offsetMs: number;
  durationMs: number;
  wav: ArrayBuffer;
};

export type SourceAudioPreparation = {
  required: boolean;
  durationMs: number;
  chunkCount: number;
};

type PrepWorkerRequest =
  | { type: 'inspect'; requestId: string; file: File }
  | { type: 'prepare-chunk'; requestId: string; file: File; startMs: number; endMs: number };

type PrepWorkerResponse =
  | { type: 'inspection'; requestId: string; durationMs: number }
  | { type: 'chunk'; requestId: string; wav: ArrayBuffer; durationMs: number }
  | { type: 'error'; requestId: string; code: string; message: string };

export type SourceAudioPrepWorkerLike = {
  postMessage(message: PrepWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<PrepWorkerResponse>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<PrepWorkerResponse>) => void): void;
  terminate(): void;
};

type WorkerFactory = () => SourceAudioPrepWorkerLike;
type ChunkConsumer = (chunk: PreparedAsrChunk) => Promise<void> | void;

export class SourceAudioPreparationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SourceAudioPreparationError';
  }
}

function defaultWorkerFactory(): SourceAudioPrepWorkerLike {
  return new Worker(
    new URL('./sourceAudioPrep.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as SourceAudioPrepWorkerLike;
}

function requestWorker(
  worker: SourceAudioPrepWorkerLike,
  request: PrepWorkerRequest,
): Promise<Exclude<PrepWorkerResponse, { type: 'error' }>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<PrepWorkerResponse>) => {
      const response = event.data;
      if (!response || response.requestId !== request.requestId) return;
      worker.removeEventListener('message', onMessage);
      if (response.type === 'error') {
        reject(new SourceAudioPreparationError(response.code, response.message || response.code));
        return;
      }
      resolve(response);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage(request);
  });
}

export async function prepareSourceAudioChunks(
  file: File,
  consumeChunk: ChunkConsumer,
  workerFactory: WorkerFactory = defaultWorkerFactory,
): Promise<SourceAudioPreparation> {
  if (!(file instanceof Blob) || file.size <= 0) {
    throw new SourceAudioPreparationError('SOURCE_AUDIO_INVALID', 'Source media file is empty or invalid.');
  }

  const worker = workerFactory();
  let sequence = 0;
  const requestId = () => `asr-prep-${++sequence}`;

  try {
    const inspection = await requestWorker(worker, { type: 'inspect', requestId: requestId(), file });
    if (inspection.type !== 'inspection') {
      throw new SourceAudioPreparationError('SOURCE_AUDIO_INVALID', 'Unexpected source inspection response.');
    }
    const durationMs = Math.round(inspection.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new SourceAudioPreparationError('SOURCE_AUDIO_INVALID', 'Source audio duration is unavailable.');
    }

    const required = durationMs > PREPARED_ASR_CHUNK_DURATION_MS || file.size > DIRECT_ASR_MAX_BYTES;
    if (!required) return { required: false, durationMs, chunkCount: 0 };

    let chunkCount = 0;
    for (let offsetMs = 0; offsetMs < durationMs; offsetMs += PREPARED_ASR_CHUNK_DURATION_MS) {
      const endMs = Math.min(durationMs, offsetMs + PREPARED_ASR_CHUNK_DURATION_MS);
      const response = await requestWorker(worker, {
        type: 'prepare-chunk',
        requestId: requestId(),
        file,
        startMs: offsetMs,
        endMs,
      });
      if (response.type !== 'chunk' || response.wav.byteLength <= 44) {
        throw new SourceAudioPreparationError('SOURCE_AUDIO_CHUNK_INVALID', `Prepared audio chunk ${chunkCount} is empty.`);
      }
      const duration = endMs - offsetMs;
      if (Math.abs(response.durationMs - duration) > 50) {
        throw new SourceAudioPreparationError('SOURCE_AUDIO_CHUNK_INVALID', `Prepared audio chunk ${chunkCount} duration is invalid.`);
      }

      await consumeChunk({
        index: chunkCount,
        offsetMs,
        durationMs: duration,
        wav: response.wav,
      });
      chunkCount += 1;
    }

    return { required: true, durationMs, chunkCount };
  } finally {
    worker.terminate();
  }
}
