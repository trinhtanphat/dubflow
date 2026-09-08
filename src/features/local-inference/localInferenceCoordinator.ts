import { ApiError } from '../../lib/api/client';
import {
  getTranslationVariants,
  type TranslationVariantDto,
} from '../translation/languageVariantsApi';
import {
  BROWSER_LOCAL_ASR,
  BROWSER_LOCAL_TRANSLATION,
  commitClientInference,
  fetchProjectSourceMedia,
  getProject,
  type ClientInferenceCommitPayload,
  type ClientInferenceState,
  type CloudProject,
} from '../projects/projectApi';
import {
  decodeSourceAudio,
  LOCAL_SOURCE_MAX_BYTES,
  LOCAL_SOURCE_MAX_DURATION_MS,
  LOCAL_SOURCE_SAMPLE_RATE,
  type DecodedSourceAudio,
} from '../upload/sourceAudioPrep';

export const LOCAL_INFERENCE_COMMIT_PATH = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/client-inference/vi`;

const LOCAL_INFERENCE_MIN_SEGMENT_MS = 100;
const LOCAL_INFERENCE_MAX_SEGMENTS = 500;
const LOCAL_INFERENCE_DURATION_TOLERANCE_MS = 1_000;

export type LocalInferencePhase =
  | 'preparing-source'
  | 'downloading-asr-model'
  | 'transcribing-local'
  | 'downloading-translation-model'
  | 'translating-local'
  | 'saving-transcript'
  | 'complete';

export class LocalInferenceCoordinatorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LocalInferenceCoordinatorError';
  }
}

type BrowserAsrSegment = { text: string; startMs: number; endMs: number };
type BrowserAsrClient = {
  transcribe(pcm: Float32Array, sampleRate: number): Promise<BrowserAsrSegment[]>;
  shutdown(): Promise<void>;
};
type BrowserTranslationClient = {
  translate(text: string): Promise<string>;
  shutdown(): Promise<void>;
};

type WorkerMessageClient = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<any>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<any>) => void): void;
  terminate(): void;
};

export type LocalInferenceCoordinatorDependencies = {
  getProject(projectId: string): Promise<CloudProject>;
  getTranslationVariants(projectId: string, targetLanguage: 'vi'): Promise<TranslationVariantDto[]>;
  fetchSourceMedia(projectId: string): Promise<File>;
  decodeSourceAudio(file: File): Promise<DecodedSourceAudio>;
  createAsrClient(): BrowserAsrClient;
  createTranslationClient(): BrowserTranslationClient;
  commitClientInference(projectId: string, payload: ClientInferenceCommitPayload): Promise<unknown>;
  createId(): string;
};

export type BrowserLocalInferenceResult = {
  variants: TranslationVariantDto[];
  resumed: boolean;
};

function fail(code: string, message: string): never {
  throw new LocalInferenceCoordinatorError(code, message);
}

function workerRequest<T>(
  worker: WorkerMessageClient,
  request: Record<string, unknown>,
  matches: (data: any) => data is T,
  transfer: Transferable[] = [],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (data?.type === 'progress') return;
      if (data?.type === 'error') {
        worker.removeEventListener('message', onMessage);
        reject(new LocalInferenceCoordinatorError(
          typeof data.code === 'string' ? data.code : 'LOCAL_INFERENCE_FAILED',
          typeof data.message === 'string' ? data.message : 'Browser-local inference failed.',
        ));
        return;
      }
      if (!matches(data)) return;
      worker.removeEventListener('message', onMessage);
      resolve(data);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage(request, transfer);
  });
}

function defaultAsrClient(): BrowserAsrClient {
  const worker = new Worker(new URL('./browserAsr.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerMessageClient;
  let sequence = 0;
  let stopped = false;
  return {
    async transcribe(pcm, sampleRate) {
      if (stopped) fail('LOCAL_ASR_FAILED', 'Browser ASR worker is unavailable.');
      const requestId = `local-asr-${++sequence}`;
      const buffer = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      const response = await workerRequest<{ type: 'result'; requestId: string; segments: BrowserAsrSegment[] }>(
        worker,
        { type: 'transcribe', requestId, pcm: buffer, sampleRate },
        (data): data is { type: 'result'; requestId: string; segments: BrowserAsrSegment[] } =>
          data?.type === 'result' && data.requestId === requestId && Array.isArray(data.segments),
        [buffer],
      );
      return response.segments;
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      try {
        await workerRequest<{ type: 'disposed' }>(
          worker,
          { type: 'shutdown' },
          (data): data is { type: 'disposed' } => data?.type === 'disposed',
        );
      } finally {
        worker.terminate();
      }
    },
  };
}

function defaultTranslationClient(): BrowserTranslationClient {
  const worker = new Worker(new URL('./browserTranslation.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerMessageClient;
  let sequence = 0;
  let stopped = false;
  return {
    async translate(text) {
      if (stopped) fail('LOCAL_TRANSLATION_FAILED', 'Browser translation worker is unavailable.');
      const requestId = `local-translation-${++sequence}`;
      const response = await workerRequest<{ type: 'result'; requestId: string; translation: string }>(
        worker,
        { type: 'translate', requestId, text },
        (data): data is { type: 'result'; requestId: string; translation: string } =>
          data?.type === 'result' && data.requestId === requestId && typeof data.translation === 'string',
      );
      const normalized = response.translation.trim();
      if (!normalized) fail('LOCAL_TRANSLATION_FAILED', 'Browser-local translation returned empty text.');
      return normalized;
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      try {
        await workerRequest<{ type: 'disposed' }>(
          worker,
          { type: 'shutdown' },
          (data): data is { type: 'disposed' } => data?.type === 'disposed',
        );
      } finally {
        worker.terminate();
      }
    },
  };
}

const DEFAULT_DEPENDENCIES: LocalInferenceCoordinatorDependencies = {
  getProject,
  getTranslationVariants: (projectId, targetLanguage) => getTranslationVariants(projectId, targetLanguage),
  fetchSourceMedia: fetchProjectSourceMedia,
  decodeSourceAudio,
  createAsrClient: defaultAsrClient,
  createTranslationClient: defaultTranslationClient,
  commitClientInference,
  createId: () => crypto.randomUUID(),
};

function browserLocalArtifactsComplete(projectId: string, project: CloudProject, variants: TranslationVariantDto[]): boolean {
  if (!['needs_review', 'completed'].includes(project.status) || variants.length === 0) return false;
  const speakerId = `browser-local:${projectId}:speaker-1`;
  return variants.every((row) => {
    const translation = row.translation;
    return row.speakerId === speakerId
      && row.endMs - row.startMs >= LOCAL_INFERENCE_MIN_SEGMENT_MS
      && row.sourceText.trim().length > 0
      && translation?.translationEngine === 'browser-opus-mt'
      && translation.translationStatus === 'completed'
      && translation.translatedText.trim().length > 0;
  });
}

function admitProject(project: CloudProject): { sourceGeneration: number; sourceObjectKey: string } {
  if (project.sourceLanguage !== 'en' || project.targetLanguage !== 'vi') {
    fail('LOCAL_INFERENCE_UNAVAILABLE', 'Browser-local inference currently supports EN to VI projects only.');
  }
  const sourceGeneration = Number(project.sourceGeneration);
  if (!Number.isInteger(sourceGeneration) || sourceGeneration <= 0) {
    fail('LOCAL_INFERENCE_UNAVAILABLE', 'Project source generation is unavailable.');
  }
  const sourceObjectKey = typeof project.sourceObjectKey === 'string' ? project.sourceObjectKey.trim() : '';
  if (!sourceObjectKey) fail('LOCAL_INFERENCE_UNAVAILABLE', 'Project source media is unavailable.');
  const sourceBytes = Number(project.sizeBytes);
  if (!Number.isFinite(sourceBytes) || sourceBytes <= 0 || sourceBytes > LOCAL_SOURCE_MAX_BYTES) {
    fail('LOCAL_INFERENCE_UNAVAILABLE', 'Project source exceeds the browser-local size boundary.');
  }
  if (project.durationMs !== null && project.durationMs !== undefined) {
    const durationMs = Number(project.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > LOCAL_SOURCE_MAX_DURATION_MS) {
      fail('LOCAL_INFERENCE_UNAVAILABLE', 'Project source exceeds the browser-local duration boundary.');
    }
  }
  if (project.status === 'processing' || project.status === 'uploading') {
    fail('LOCAL_INFERENCE_BUSY', 'Project source is currently busy.');
  }
  return { sourceGeneration, sourceObjectKey };
}

function resumeStateMatches(
  source: { sourceGeneration: number; sourceObjectKey: string },
  state: ClientInferenceState | null | undefined,
): boolean {
  return state != null
    && state.sourceGeneration === source.sourceGeneration
    && state.sourceObjectKey === source.sourceObjectKey
    && state.asr?.provider === BROWSER_LOCAL_ASR.provider
    && state.asr.model === BROWSER_LOCAL_ASR.model
    && state.asr.revision === BROWSER_LOCAL_ASR.revision
    && state.translation?.provider === BROWSER_LOCAL_TRANSLATION.provider
    && state.translation.model === BROWSER_LOCAL_TRANSLATION.model
    && state.translation.revision === BROWSER_LOCAL_TRANSLATION.revision;
}

function normalizeAsrSegments(
  rawSegments: BrowserAsrSegment[],
  durationMs: number,
  createId: () => string,
): ClientInferenceCommitPayload['segments'] {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    fail('LOCAL_ASR_EMPTY', 'Browser-local speech recognition produced no usable segments.');
  }
  if (rawSegments.length > LOCAL_INFERENCE_MAX_SEGMENTS) {
    fail('LOCAL_ASR_INVALID', 'Browser-local speech recognition exceeded the 500 segment boundary.');
  }

  const result: ClientInferenceCommitPayload['segments'] = [];
  const ids = new Set<string>();
  let previousEndMs = 0;
  for (const raw of rawSegments) {
    const sourceText = typeof raw.text === 'string' ? raw.text.trim() : '';
    const startMs = Math.round(Number(raw.startMs));
    const endMs = Math.round(Number(raw.endMs));
    if (!sourceText
      || !Number.isInteger(startMs)
      || !Number.isInteger(endMs)
      || startMs < 0
      || endMs <= startMs
      || endMs - startMs < LOCAL_INFERENCE_MIN_SEGMENT_MS
      || startMs < previousEndMs
      || endMs > durationMs) {
      fail('LOCAL_ASR_INVALID', 'Browser-local speech recognition produced invalid segment timing.');
    }
    const id = createId().trim();
    if (!id || ids.has(id)) {
      fail('LOCAL_ASR_INVALID', 'Browser-local speech recognition produced invalid segment identity.');
    }
    ids.add(id);
    result.push({ id, startMs, endMs, sourceText });
    previousEndMs = endMs;
  }
  return result;
}

export async function runBrowserLocalInference(
  projectId: string,
  options: {
    dependencies?: LocalInferenceCoordinatorDependencies;
    onPhase?: (phase: LocalInferencePhase) => void;
  } = {},
): Promise<BrowserLocalInferenceResult> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const phase = (value: LocalInferencePhase) => options.onPhase?.(value);

  phase('preparing-source');
  const project = await dependencies.getProject(projectId);
  const source = admitProject(project);
  const existingVariants = await dependencies.getTranslationVariants(projectId, 'vi');
  if (resumeStateMatches(source, project.clientInferenceState)
    && browserLocalArtifactsComplete(projectId, project, existingVariants)) {
    phase('complete');
    return { variants: existingVariants, resumed: true };
  }

  const file = await dependencies.fetchSourceMedia(projectId);
  if (file.size <= 0 || file.size > LOCAL_SOURCE_MAX_BYTES) {
    fail('LOCAL_INFERENCE_UNAVAILABLE', 'Downloaded source exceeds the browser-local size boundary.');
  }
  const decoded = await dependencies.decodeSourceAudio(file);
  const durationMs = Math.round(Number(decoded.durationMs));
  if (decoded.sampleRate !== LOCAL_SOURCE_SAMPLE_RATE
    || !Number.isInteger(durationMs)
    || durationMs <= 0
    || durationMs > LOCAL_SOURCE_MAX_DURATION_MS) {
    fail('LOCAL_SOURCE_DECODE_FAILED', 'Decoded source does not satisfy the local inference contract.');
  }
  if (project.durationMs !== null && project.durationMs !== undefined
    && Math.abs(Number(project.durationMs) - durationMs) > LOCAL_INFERENCE_DURATION_TOLERANCE_MS) {
    fail('LOCAL_INFERENCE_SOURCE_CONFLICT', 'Project source duration changed before local inference.');
  }

  phase('downloading-asr-model');
  const asr = dependencies.createAsrClient();
  let rawSegments: BrowserAsrSegment[];
  try {
    phase('transcribing-local');
    rawSegments = await asr.transcribe(decoded.pcm, decoded.sampleRate);
  } finally {
    await asr.shutdown();
  }
  const segments = normalizeAsrSegments(rawSegments, durationMs, dependencies.createId);

  phase('downloading-translation-model');
  const translator = dependencies.createTranslationClient();
  const translations: ClientInferenceCommitPayload['translations'] = [];
  try {
    phase('translating-local');
    for (const segment of segments) {
      const translatedText = (await translator.translate(segment.sourceText)).trim();
      if (!translatedText) fail('LOCAL_TRANSLATION_FAILED', 'Browser-local translation produced empty output.');
      translations.push({ segmentId: segment.id, translatedText });
    }
  } finally {
    await translator.shutdown();
  }

  const payload: ClientInferenceCommitPayload = {
    expectedSourceGeneration: source.sourceGeneration,
    expectedSourceObjectKey: source.sourceObjectKey,
    durationMs,
    asr: BROWSER_LOCAL_ASR,
    translation: BROWSER_LOCAL_TRANSLATION,
    segments,
    translations,
  };

  phase('saving-transcript');
  try {
    await dependencies.commitClientInference(projectId, payload);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === 'LOCAL_INFERENCE_SOURCE_CONFLICT') {
      throw new LocalInferenceCoordinatorError(
        'LOCAL_INFERENCE_SOURCE_CONFLICT',
        'Project source changed while browser-local inference was running. Run local processing again.',
      );
    }
    throw error;
  }

  const variants = await dependencies.getTranslationVariants(projectId, 'vi');
  if (!browserLocalArtifactsComplete(projectId, { ...project, status: 'needs_review' }, variants)) {
    fail('LOCAL_INFERENCE_COMMIT_FAILED', 'Canonical Vietnamese variants are incomplete after local inference commit.');
  }
  phase('complete');
  return { variants, resumed: false };
}
