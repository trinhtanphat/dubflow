/// <reference lib="webworker" />

export const BROWSER_ASR_MODEL = {
  task: 'automatic-speech-recognition',
  model: 'onnx-community/whisper-tiny.en',
  revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
  dtype: 'q8',
} as const;

const LOCAL_ASR_SAMPLE_RATE = 16_000;
const WEBGPU_OPTIONS = { device: 'webgpu' as const };
const WASM_OPTIONS = { device: 'wasm' as const };

type BrowserAsrDevice = 'webgpu' | 'wasm';

type PipelineOptions = {
  revision: string;
  dtype: string;
  device: BrowserAsrDevice;
  progress_callback?: (event: unknown) => void;
};

type AsrChunk = {
  text?: string;
  timestamp?: [number | null, number | null];
};

type AsrOutput = {
  text?: string;
  chunks?: AsrChunk[];
};

type AsrPipeline = ((pcm: Float32Array, options: Record<string, unknown>) => Promise<AsrOutput>) & {
  dispose?: () => Promise<void> | void;
};

export type BrowserAsrPipelineFactory = (
  task: string,
  model: string,
  options: PipelineOptions,
) => Promise<AsrPipeline>;

export type BrowserAsrProgress = {
  status: string;
  progress?: number;
};

export type BrowserAsrSegment = {
  text: string;
  startMs: number;
  endMs: number;
};

async function defaultPipelineFactory(
  task: string,
  model: string,
  options: PipelineOptions,
): Promise<AsrPipeline> {
  const transformers = await import('@huggingface/transformers');
  const pipeline = transformers.pipeline as unknown as BrowserAsrPipelineFactory;
  return pipeline(task, model, options);
}

function progressValue(event: unknown): BrowserAsrProgress | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : 'loading';
  const directProgress = typeof record.progress === 'number' && Number.isFinite(record.progress)
    ? record.progress
    : undefined;
  if (directProgress !== undefined) return { status, progress: directProgress };

  const loaded = typeof record.loaded === 'number' ? record.loaded : undefined;
  const total = typeof record.total === 'number' ? record.total : undefined;
  if (loaded !== undefined && total !== undefined && total > 0) {
    return { status, progress: Math.max(0, Math.min(100, loaded / total * 100)) };
  }
  return { status };
}

function normalizeChunks(output: AsrOutput): BrowserAsrSegment[] {
  if (!Array.isArray(output.chunks)) return [];
  const segments: BrowserAsrSegment[] = [];
  for (const chunk of output.chunks) {
    const text = typeof chunk.text === 'string' ? chunk.text.trim() : '';
    const timestamp = chunk.timestamp;
    if (!text || !timestamp || timestamp.length !== 2) continue;
    const [startSeconds, endSeconds] = timestamp;
    if (
      typeof startSeconds !== 'number'
      || typeof endSeconds !== 'number'
      || !Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
    ) continue;
    segments.push({
      text,
      startMs: Math.round(startSeconds * 1000),
      endMs: Math.round(endSeconds * 1000),
    });
  }
  return segments;
}

export function createBrowserAsrRuntime(options: {
  pipelineFactory?: BrowserAsrPipelineFactory;
  onProgress?: (event: BrowserAsrProgress) => void;
} = {}) {
  const pipelineFactory = options.pipelineFactory ?? defaultPipelineFactory;
  let transcriber: AsrPipeline | null = null;
  let initPromise: Promise<AsrPipeline> | null = null;
  let activeDevice: BrowserAsrDevice | null = null;
  let inferenceStarted = false;
  let disposed = false;

  const loadPipeline = async (deviceOptions: typeof WEBGPU_OPTIONS | typeof WASM_OPTIONS) => {
    const loaded = await pipelineFactory(
      BROWSER_ASR_MODEL.task,
      BROWSER_ASR_MODEL.model,
      {
        revision: BROWSER_ASR_MODEL.revision,
        dtype: BROWSER_ASR_MODEL.dtype,
        ...deviceOptions,
        progress_callback: (event: unknown) => {
          const progress = progressValue(event);
          if (progress) options.onProgress?.(progress);
        },
      },
    );
    activeDevice = deviceOptions.device;
    return loaded;
  };

  const ensurePipeline = async (): Promise<AsrPipeline> => {
    if (disposed) throw new Error('Browser ASR runtime is disposed.');
    if (transcriber) return transcriber;
    if (!initPromise) {
      initPromise = (async () => {
        try {
          return await loadPipeline(WEBGPU_OPTIONS);
        } catch (webGpuError) {
          if (inferenceStarted) throw webGpuError;
          return loadPipeline(WASM_OPTIONS);
        }
      })();
    }
    try {
      transcriber = await initPromise;
      return transcriber;
    } catch (error) {
      initPromise = null;
      throw error;
    }
  };

  return {
    async prepare(): Promise<BrowserAsrDevice> {
      await ensurePipeline();
      if (!activeDevice) throw new Error('Browser ASR model did not initialize.');
      return activeDevice;
    },

    async transcribe(pcm: Float32Array, sampleRate: number): Promise<BrowserAsrSegment[]> {
      if (!(pcm instanceof Float32Array) || pcm.length === 0) {
        throw new Error('Browser ASR requires non-empty Float32 PCM.');
      }
      if (sampleRate !== LOCAL_ASR_SAMPLE_RATE) {
        throw new Error('Browser ASR requires mono 16 kHz PCM.');
      }

      const pipeline = await ensurePipeline();
      inferenceStarted = true;
      const output = await pipeline(pcm, { return_timestamps: true });
      return normalizeChunks(output);
    },

    async shutdown(): Promise<void> {
      disposed = true;
      const pipeline = transcriber ?? (initPromise ? await initPromise.catch(() => null) : null);
      transcriber = null;
      initPromise = null;
      activeDevice = null;
      if (pipeline?.dispose) await pipeline.dispose();
    },
  };
}

type BrowserAsrWorkerRequest =
  | { type: 'init' }
  | { type: 'transcribe'; requestId: string; pcm: ArrayBuffer; sampleRate: number }
  | { type: 'shutdown' };

type BrowserAsrWorkerResponse =
  | { type: 'progress'; status: string; progress?: number }
  | { type: 'ready'; device: BrowserAsrDevice }
  | { type: 'result'; requestId: string; segments: BrowserAsrSegment[] }
  | { type: 'disposed' }
  | { type: 'error'; requestId?: string; code: 'LOCAL_ASR_FAILED'; message: string };

const scope = typeof self === 'undefined'
  ? null
  : self as unknown as DedicatedWorkerGlobalScope;

if (scope && typeof scope.addEventListener === 'function') {
  const runtime = createBrowserAsrRuntime({
    onProgress: (event) => {
      scope.postMessage({ type: 'progress', ...event } satisfies BrowserAsrWorkerResponse);
    },
  });
  let active = false;

  scope.addEventListener('message', (event: MessageEvent<BrowserAsrWorkerRequest>) => {
    const request = event.data;
    if (!request) return;

    void (async () => {
      try {
        if (request.type === 'shutdown') {
          await runtime.shutdown();
          scope.postMessage({ type: 'disposed' } satisfies BrowserAsrWorkerResponse);
          return;
        }
        if (request.type === 'init') {
          const device = await runtime.prepare();
          scope.postMessage({ type: 'ready', device } satisfies BrowserAsrWorkerResponse);
          return;
        }
        if (request.type !== 'transcribe') return;
        if (active) throw new Error('Browser ASR inference is already active.');
        if (!(request.pcm instanceof ArrayBuffer)) throw new Error('Browser ASR PCM payload is invalid.');

        active = true;
        try {
          const segments = await runtime.transcribe(new Float32Array(request.pcm), request.sampleRate);
          scope.postMessage({
            type: 'result',
            requestId: request.requestId,
            segments,
          } satisfies BrowserAsrWorkerResponse);
        } finally {
          active = false;
        }
      } catch {
        scope.postMessage({
          type: 'error',
          requestId: request.type === 'transcribe' ? request.requestId : undefined,
          code: 'LOCAL_ASR_FAILED',
          message: 'Browser-local speech recognition failed.',
        } satisfies BrowserAsrWorkerResponse);
      }
    })();
  });
}
