/// <reference lib="webworker" />

export const BROWSER_TRANSLATION_MODEL = {
  task: 'translation',
  model: 'Xenova/opus-mt-en-vi',
  revision: '3f5f449333cbc7ecaa9eec16ee9e37682f036b8e',
  dtype: 'q8',
} as const;

const WEBGPU_OPTIONS = { device: 'webgpu' as const };
const WASM_OPTIONS = { device: 'wasm' as const };

type BrowserTranslationDevice = 'webgpu' | 'wasm';

type PipelineOptions = {
  revision: string;
  dtype: string;
  device: BrowserTranslationDevice;
  progress_callback?: (event: unknown) => void;
};

type TranslationOutput = {
  translation_text?: string;
};

type TranslationPipeline = ((text: string) => Promise<TranslationOutput | TranslationOutput[]>) & {
  dispose?: () => Promise<void> | void;
};

export type BrowserTranslationPipelineFactory = (
  task: string,
  model: string,
  options: PipelineOptions,
) => Promise<TranslationPipeline>;

export type BrowserTranslationProgress = {
  status: string;
  progress?: number;
};

async function defaultPipelineFactory(
  task: string,
  model: string,
  options: PipelineOptions,
): Promise<TranslationPipeline> {
  const transformers = await import('@huggingface/transformers');
  const pipeline = transformers.pipeline as unknown as BrowserTranslationPipelineFactory;
  return pipeline(task, model, options);
}

function progressValue(event: unknown): BrowserTranslationProgress | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : 'loading';
  if (typeof record.progress === 'number' && Number.isFinite(record.progress)) {
    return { status, progress: record.progress };
  }
  const loaded = typeof record.loaded === 'number' ? record.loaded : undefined;
  const total = typeof record.total === 'number' ? record.total : undefined;
  if (loaded !== undefined && total !== undefined && total > 0) {
    return { status, progress: Math.max(0, Math.min(100, loaded / total * 100)) };
  }
  return { status };
}

function translatedText(output: TranslationOutput | TranslationOutput[]): string {
  const item = Array.isArray(output) ? output[0] : output;
  const text = typeof item?.translation_text === 'string' ? item.translation_text.trim() : '';
  if (!text) throw new Error('Browser translation produced empty output.');
  return text;
}

export function createBrowserTranslationRuntime(options: {
  pipelineFactory?: BrowserTranslationPipelineFactory;
  onProgress?: (event: BrowserTranslationProgress) => void;
} = {}) {
  const pipelineFactory = options.pipelineFactory ?? defaultPipelineFactory;
  let translator: TranslationPipeline | null = null;
  let initPromise: Promise<TranslationPipeline> | null = null;
  let activeDevice: BrowserTranslationDevice | null = null;
  let inferenceStarted = false;
  let disposed = false;

  const loadPipeline = async (deviceOptions: typeof WEBGPU_OPTIONS | typeof WASM_OPTIONS) => {
    const loaded = await pipelineFactory(
      BROWSER_TRANSLATION_MODEL.task,
      BROWSER_TRANSLATION_MODEL.model,
      {
        revision: BROWSER_TRANSLATION_MODEL.revision,
        dtype: BROWSER_TRANSLATION_MODEL.dtype,
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

  const ensurePipeline = async (): Promise<TranslationPipeline> => {
    if (disposed) throw new Error('Browser translation runtime is disposed.');
    if (translator) return translator;
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
      translator = await initPromise;
      return translator;
    } catch (error) {
      initPromise = null;
      throw error;
    }
  };

  return {
    async prepare(): Promise<BrowserTranslationDevice> {
      await ensurePipeline();
      if (!activeDevice) throw new Error('Browser translation model did not initialize.');
      return activeDevice;
    },

    async translate(text: string): Promise<string> {
      const normalized = text.trim();
      if (!normalized) throw new Error('Browser translation input is empty.');
      const pipeline = await ensurePipeline();
      inferenceStarted = true;
      return translatedText(await pipeline(normalized));
    },

    async shutdown(): Promise<void> {
      disposed = true;
      const pipeline = translator ?? (initPromise ? await initPromise.catch(() => null) : null);
      translator = null;
      initPromise = null;
      activeDevice = null;
      if (pipeline?.dispose) await pipeline.dispose();
    },
  };
}

type BrowserTranslationWorkerRequest =
  | { type: 'init' }
  | { type: 'translate'; requestId: string; text: string }
  | { type: 'shutdown' };

type BrowserTranslationWorkerResponse =
  | { type: 'progress'; status: string; progress?: number }
  | { type: 'ready'; device: BrowserTranslationDevice }
  | { type: 'result'; requestId: string; translation: string }
  | { type: 'disposed' }
  | { type: 'error'; requestId?: string; code: 'LOCAL_TRANSLATION_FAILED'; message: string };

const scope = typeof self === 'undefined'
  ? null
  : self as unknown as DedicatedWorkerGlobalScope;

if (scope && typeof scope.addEventListener === 'function') {
  const runtime = createBrowserTranslationRuntime({
    onProgress: (event) => {
      scope.postMessage({ type: 'progress', ...event } satisfies BrowserTranslationWorkerResponse);
    },
  });
  let active = false;

  scope.addEventListener('message', (event: MessageEvent<BrowserTranslationWorkerRequest>) => {
    const request = event.data;
    if (!request) return;

    void (async () => {
      try {
        if (request.type === 'shutdown') {
          await runtime.shutdown();
          scope.postMessage({ type: 'disposed' } satisfies BrowserTranslationWorkerResponse);
          return;
        }
        if (request.type === 'init') {
          const device = await runtime.prepare();
          scope.postMessage({ type: 'ready', device } satisfies BrowserTranslationWorkerResponse);
          return;
        }
        if (request.type !== 'translate') return;
        if (active) throw new Error('Browser translation inference is already active.');

        active = true;
        try {
          const translation = await runtime.translate(request.text);
          scope.postMessage({
            type: 'result',
            requestId: request.requestId,
            translation,
          } satisfies BrowserTranslationWorkerResponse);
        } finally {
          active = false;
        }
      } catch {
        scope.postMessage({
          type: 'error',
          requestId: request.type === 'translate' ? request.requestId : undefined,
          code: 'LOCAL_TRANSLATION_FAILED',
          message: 'Browser-local translation failed.',
        } satisfies BrowserTranslationWorkerResponse);
      }
    })();
  });
}
