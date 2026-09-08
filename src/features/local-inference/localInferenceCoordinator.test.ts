import { describe, expect, it, vi } from 'vitest';
import * as browserAsr from './browserAsr.worker';
import * as browserTranslation from './browserTranslation.worker';
import * as localCoordinator from './localInferenceCoordinator';

type PipelineOptions = {
  revision: string;
  dtype: string;
  device: 'webgpu' | 'wasm';
  progress_callback?: (event: unknown) => void;
};

type AsrOutput = {
  text?: string;
  chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }>;
};

type PipelineLike = ((pcm: Float32Array, options: Record<string, unknown>) => Promise<AsrOutput>) & {
  dispose?: () => Promise<void> | void;
};

type PipelineFactory = (
  task: string,
  model: string,
  options: PipelineOptions,
) => Promise<PipelineLike>;

type BrowserAsrRuntime = {
  transcribe(pcm: Float32Array, sampleRate: number): Promise<Array<{ text: string; startMs: number; endMs: number }>>;
  shutdown(): Promise<void>;
};

type RuntimeFactory = (options: {
  pipelineFactory: PipelineFactory;
  onProgress?: (event: { status: string; progress?: number }) => void;
}) => BrowserAsrRuntime;

function runtimeFactory(): RuntimeFactory {
  const candidate = (browserAsr as Record<string, unknown>).createBrowserAsrRuntime;
  expect(typeof candidate).toBe('function');
  return candidate as RuntimeFactory;
}

function pipelineReturning(output: AsrOutput): PipelineLike {
  return Object.assign(
    vi.fn(async () => output),
    { dispose: vi.fn(async () => undefined) },
  ) as unknown as PipelineLike;
}

describe('browser Whisper ASR runtime', () => {
  it('initializes the exact pinned q8 Whisper model on WebGPU and converts timestamp chunks to ms', async () => {
    const createBrowserAsrRuntime = runtimeFactory();
    const pipe = pipelineReturning({
      chunks: [
        { text: ' Hello ', timestamp: [0, 1.25] },
        { text: 'world', timestamp: [1.25, 2] },
      ],
    });
    const pipelineFactory = vi.fn(async () => pipe) as unknown as PipelineFactory;
    const runtime = createBrowserAsrRuntime({ pipelineFactory });
    const pcm = new Float32Array([0.1, -0.1, 0.2]);

    const segments = await runtime.transcribe(pcm, 16_000);

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(pipelineFactory).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny.en',
      expect.objectContaining({
        revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
        dtype: 'q8',
        device: 'webgpu',
      }),
    );
    expect(pipe).toHaveBeenCalledWith(pcm, expect.objectContaining({ return_timestamps: true }));
    expect(segments).toEqual([
      { text: 'Hello', startMs: 0, endMs: 1_250 },
      { text: 'world', startMs: 1_250, endMs: 2_000 },
    ]);
  });

  it('retries initialization exactly once on WASM when WebGPU initialization fails before inference', async () => {
    const createBrowserAsrRuntime = runtimeFactory();
    const pipe = pipelineReturning({ chunks: [{ text: 'ok', timestamp: [0, 0.5] }] });
    const devices: string[] = [];
    const pipelineFactory: PipelineFactory = async (_task, _model, options) => {
      devices.push(options.device);
      if (options.device === 'webgpu') throw new Error('webgpu unavailable');
      return pipe;
    };
    const runtime = createBrowserAsrRuntime({ pipelineFactory });

    await expect(runtime.transcribe(new Float32Array([0.1]), 16_000)).resolves.toEqual([
      { text: 'ok', startMs: 0, endMs: 500 },
    ]);
    expect(devices).toEqual(['webgpu', 'wasm']);
  });

  it('does not switch device after inference has started and the pipeline invocation fails', async () => {
    const createBrowserAsrRuntime = runtimeFactory();
    const pipe = Object.assign(
      vi.fn(async () => { throw new Error('inference failed'); }),
      { dispose: vi.fn(async () => undefined) },
    ) as unknown as PipelineLike;
    const pipelineFactory = vi.fn(async () => pipe) as unknown as PipelineFactory;
    const runtime = createBrowserAsrRuntime({ pipelineFactory });

    await expect(runtime.transcribe(new Float32Array([0.1]), 16_000)).rejects.toThrow();
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(pipelineFactory).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ device: 'webgpu' }),
    );
  });

  it('rejects non-16k or empty PCM before model initialization and disposes the initialized pipeline on shutdown', async () => {
    const createBrowserAsrRuntime = runtimeFactory();
    const pipe = pipelineReturning({ chunks: [{ text: 'ok', timestamp: [0, 0.5] }] });
    const pipelineFactory = vi.fn(async () => pipe) as unknown as PipelineFactory;
    const runtime = createBrowserAsrRuntime({ pipelineFactory });

    await expect(runtime.transcribe(new Float32Array(), 16_000)).rejects.toThrow();
    await expect(runtime.transcribe(new Float32Array([0.1]), 48_000)).rejects.toThrow();
    expect(pipelineFactory).not.toHaveBeenCalled();

    await runtime.transcribe(new Float32Array([0.1]), 16_000);
    await runtime.shutdown();
    expect(pipe.dispose).toHaveBeenCalledTimes(1);
  });
});

type TranslationOutput = { translation_text?: string };
type TranslationPipelineLike = ((text: string) => Promise<TranslationOutput | TranslationOutput[]>) & {
  dispose?: () => Promise<void> | void;
};
type TranslationPipelineFactory = (
  task: string,
  model: string,
  options: PipelineOptions,
) => Promise<TranslationPipelineLike>;
type BrowserTranslationRuntime = {
  translate(text: string): Promise<string>;
  shutdown(): Promise<void>;
};
type TranslationRuntimeFactory = (options: {
  pipelineFactory: TranslationPipelineFactory;
  onProgress?: (event: { status: string; progress?: number }) => void;
}) => BrowserTranslationRuntime;

function translationRuntimeFactory(): TranslationRuntimeFactory {
  const candidate = (browserTranslation as Record<string, unknown>).createBrowserTranslationRuntime;
  expect(typeof candidate).toBe('function');
  return candidate as TranslationRuntimeFactory;
}

function translationPipelineReturning(output: TranslationOutput | TranslationOutput[]): TranslationPipelineLike {
  return Object.assign(
    vi.fn(async () => output),
    { dispose: vi.fn(async () => undefined) },
  ) as unknown as TranslationPipelineLike;
}

describe('browser Marian EN-to-VI runtime', () => {
  it('initializes the exact pinned q8 Marian model on WebGPU and returns trimmed translation text', async () => {
    const createBrowserTranslationRuntime = translationRuntimeFactory();
    const pipe = translationPipelineReturning([{ translation_text: ' Xin chào ' }]);
    const pipelineFactory = vi.fn(async () => pipe) as unknown as TranslationPipelineFactory;
    const runtime = createBrowserTranslationRuntime({ pipelineFactory });

    await expect(runtime.translate('Hello')).resolves.toBe('Xin chào');
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(pipelineFactory).toHaveBeenCalledWith(
      'translation',
      'Xenova/opus-mt-en-vi',
      expect.objectContaining({
        revision: '3f5f449333cbc7ecaa9eec16ee9e37682f036b8e',
        dtype: 'q8',
        device: 'webgpu',
      }),
    );
    expect(pipe).toHaveBeenCalledWith('Hello');
  });

  it('retries initialization exactly once on WASM before translation begins', async () => {
    const createBrowserTranslationRuntime = translationRuntimeFactory();
    const pipe = translationPipelineReturning({ translation_text: 'Được' });
    const devices: string[] = [];
    const pipelineFactory: TranslationPipelineFactory = async (_task, _model, options) => {
      devices.push(options.device);
      if (options.device === 'webgpu') throw new Error('webgpu unavailable');
      return pipe;
    };
    const runtime = createBrowserTranslationRuntime({ pipelineFactory });

    await expect(runtime.translate('Okay')).resolves.toBe('Được');
    expect(devices).toEqual(['webgpu', 'wasm']);
  });

  it('rejects empty input/output, never switches device after inference failure, and disposes on shutdown', async () => {
    const createBrowserTranslationRuntime = translationRuntimeFactory();
    const failingPipe = Object.assign(
      vi.fn(async () => { throw new Error('translation failed'); }),
      { dispose: vi.fn(async () => undefined) },
    ) as unknown as TranslationPipelineLike;
    const pipelineFactory = vi.fn(async () => failingPipe) as unknown as TranslationPipelineFactory;
    const runtime = createBrowserTranslationRuntime({ pipelineFactory });

    await expect(runtime.translate('   ')).rejects.toThrow();
    expect(pipelineFactory).not.toHaveBeenCalled();
    await expect(runtime.translate('Hello')).rejects.toThrow();
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
    expect(failingPipe.dispose).toHaveBeenCalledTimes(1);

    const emptyPipe = translationPipelineReturning([{ translation_text: '   ' }]);
    const emptyRuntime = createBrowserTranslationRuntime({ pipelineFactory: async () => emptyPipe });
    await expect(emptyRuntime.translate('Hello')).rejects.toThrow();
  });
});

type CoordinatorDependencies = {
  getProject(projectId: string): Promise<any>;
  getTranslationVariants(projectId: string, targetLanguage: 'vi'): Promise<any[]>;
  getClientInferenceState(projectId: string): Promise<any | null>;
  fetchSourceMedia(projectId: string): Promise<File>;
  decodeSourceAudio(file: File): Promise<{ pcm: Float32Array; durationMs: number; sampleRate: 16000 }>;
  createAsrClient(): { transcribe(pcm: Float32Array, sampleRate: number): Promise<Array<{ text: string; startMs: number; endMs: number }>>; shutdown(): Promise<void> };
  createTranslationClient(): { translate(text: string): Promise<string>; shutdown(): Promise<void> };
  commitClientInference(projectId: string, payload: any): Promise<any>;
  createId(): string;
};

type CoordinatorRun = (
  projectId: string,
  options: { dependencies: CoordinatorDependencies; onPhase?: (phase: string) => void },
) => Promise<{ variants: any[]; resumed: boolean }>;

function coordinatorRun(): CoordinatorRun {
  const candidate = (localCoordinator as Record<string, unknown>).runBrowserLocalInference;
  expect(typeof candidate).toBe('function');
  return candidate as CoordinatorRun;
}

function exactResumeState() {
  return {
    sourceGeneration: 3,
    sourceObjectKey: 'projects/p1/source/current.mp4',
    asr: {
      provider: 'browser-whisper',
      model: 'onnx-community/whisper-tiny.en',
      revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
    },
    translation: {
      provider: 'browser-opus-mt',
      model: 'Xenova/opus-mt-en-vi',
      revision: '3f5f449333cbc7ecaa9eec16ee9e37682f036b8e',
    },
  };
}

describe('browser-local inference coordinator', () => {
  it('decodes source, disposes Whisper before Marian, commits exact provenance, and returns canonical vi variants', async () => {
    const runBrowserLocalInference = coordinatorRun();
    const events: string[] = [];
    const canonical = [{
      segmentId: 'seg-1', speakerId: 'browser-local:p1:speaker-1', startMs: 0, endMs: 1000, sourceText: 'Hello', sourceVersion: 1,
      translation: { translationEngine: 'browser-opus-mt', translationStatus: 'completed', translatedText: 'Xin chào' },
    }];
    let variantReads = 0;
    let committedPayload: any = null;
    const deps: CoordinatorDependencies = {
      getProject: async () => ({
        id: 'p1', sourceLanguage: 'en', targetLanguage: 'vi', sourceGeneration: 3,
        sourceObjectKey: 'projects/p1/source/current.mp4', sizeBytes: 1024, durationMs: 1000, status: 'ready',
      }),
      getTranslationVariants: async () => (++variantReads === 1 ? [] : canonical),
      getClientInferenceState: async () => null,
      fetchSourceMedia: async () => new File([new Uint8Array([1, 2, 3])], 'source.mp4', { type: 'video/mp4' }),
      decodeSourceAudio: async () => ({ pcm: new Float32Array([0.1, -0.1]), durationMs: 1000, sampleRate: 16000 }),
      createAsrClient: () => ({
        transcribe: async () => { events.push('asr'); return [{ text: 'Hello', startMs: 0, endMs: 1000 }]; },
        shutdown: async () => { events.push('asr-shutdown'); },
      }),
      createTranslationClient: () => ({
        translate: async () => { events.push('translation'); return 'Xin chào'; },
        shutdown: async () => { events.push('translation-shutdown'); },
      }),
      commitClientInference: async (_projectId, payload) => { events.push('commit'); committedPayload = payload; return { projectId: 'p1' }; },
      createId: () => 'seg-1',
    };

    const result = await runBrowserLocalInference('p1', { dependencies: deps, onPhase: (phase) => events.push(`phase:${phase}`) });

    expect(result).toEqual({ variants: canonical, resumed: false });
    expect(events.indexOf('asr-shutdown')).toBeLessThan(events.indexOf('translation'));
    expect(events.indexOf('translation-shutdown')).toBeLessThan(events.indexOf('commit'));
    expect(committedPayload).toMatchObject({
      expectedSourceGeneration: 3,
      expectedSourceObjectKey: 'projects/p1/source/current.mp4',
      durationMs: 1000,
      asr: {
        provider: 'browser-whisper',
        model: 'onnx-community/whisper-tiny.en',
        revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
      },
      translation: {
        provider: 'browser-opus-mt',
        model: 'Xenova/opus-mt-en-vi',
        revision: '3f5f449333cbc7ecaa9eec16ee9e37682f036b8e',
      },
      segments: [{ id: 'seg-1', startMs: 0, endMs: 1000, sourceText: 'Hello' }],
      translations: [{ segmentId: 'seg-1', translatedText: 'Xin chào' }],
    });
  });

  it('resumes complete current browser-local artifacts without downloading media or starting model workers', async () => {
    const runBrowserLocalInference = coordinatorRun();
    const canonical = [{
      segmentId: 'seg-1', speakerId: 'browser-local:p1:speaker-1', startMs: 0, endMs: 1000, sourceText: 'Hello', sourceVersion: 1,
      translation: { translationEngine: 'browser-opus-mt', translationStatus: 'completed', translatedText: 'Xin chào' },
    }];
    const forbidden = vi.fn(async () => { throw new Error('should not run'); });
    const deps: CoordinatorDependencies = {
      getProject: async () => ({
        id: 'p1', sourceLanguage: 'en', targetLanguage: 'vi', sourceGeneration: 3,
        sourceObjectKey: 'projects/p1/source/current.mp4', sizeBytes: 1024, durationMs: 1000, status: 'needs_review',
      }),
      getTranslationVariants: async () => canonical,
      getClientInferenceState: async () => exactResumeState(),
      fetchSourceMedia: forbidden,
      decodeSourceAudio: forbidden,
      createAsrClient: () => { throw new Error('should not start ASR'); },
      createTranslationClient: () => { throw new Error('should not start translation'); },
      commitClientInference: forbidden,
      createId: () => 'unused',
    };

    await expect(runBrowserLocalInference('p1', { dependencies: deps })).resolves.toEqual({ variants: canonical, resumed: true });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('fails LOCAL_ASR_EMPTY before translation or commit', async () => {
    const runBrowserLocalInference = coordinatorRun();
    const commit = vi.fn(async () => ({}));
    const deps: CoordinatorDependencies = {
      getProject: async () => ({
        id: 'p1', sourceLanguage: 'en', targetLanguage: 'vi', sourceGeneration: 3,
        sourceObjectKey: 'projects/p1/source/current.mp4', sizeBytes: 1024, durationMs: 1000, status: 'ready',
      }),
      getTranslationVariants: async () => [],
      getClientInferenceState: async () => null,
      fetchSourceMedia: async () => new File([new Uint8Array([1])], 'source.mp4'),
      decodeSourceAudio: async () => ({ pcm: new Float32Array([0.1]), durationMs: 1000, sampleRate: 16000 }),
      createAsrClient: () => ({ transcribe: async () => [], shutdown: async () => undefined }),
      createTranslationClient: () => { throw new Error('translation should not start'); },
      commitClientInference: commit,
      createId: () => 'unused',
    };

    await expect(runBrowserLocalInference('p1', { dependencies: deps })).rejects.toMatchObject({ code: 'LOCAL_ASR_EMPTY' });
    expect(commit).not.toHaveBeenCalled();
  });
});
