export const LOCAL_INFERENCE_ASR = {
  provider: 'browser-whisper',
  model: 'onnx-community/whisper-tiny.en',
  revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
} as const;

export const LOCAL_INFERENCE_TRANSLATION = {
  provider: 'browser-opus-mt',
  model: 'Xenova/opus-mt-en-vi',
  revision: '3f5f449333cbc7ecaa9eec16ee9e37682f036b8e',
} as const;

export const LOCAL_INFERENCE_MAX_SOURCE_BYTES = 24 * 1024 * 1024;
export const LOCAL_INFERENCE_MAX_DURATION_MS = 300_000;
export const LOCAL_INFERENCE_MAX_SEGMENTS = 500;
export const LOCAL_INFERENCE_MAX_COMMIT_BYTES = 2 * 1024 * 1024;
export const LOCAL_INFERENCE_DURATION_TOLERANCE_MS = 1_000;
export const LOCAL_INFERENCE_MIN_SEGMENT_MS = 100;
export const LOCAL_INFERENCE_MAX_TEXT_CHARS = 65_536;

export type LocalInferenceSegment = {
  id: string;
  startMs: number;
  endMs: number;
  sourceText: string;
};

export type LocalInferenceTranslation = {
  segmentId: string;
  translatedText: string;
};

export type ClientInferenceInput = {
  expectedSourceGeneration: number;
  expectedSourceObjectKey: string;
  durationMs: number;
  asr: typeof LOCAL_INFERENCE_ASR;
  translation: typeof LOCAL_INFERENCE_TRANSLATION;
  segments: LocalInferenceSegment[];
  translations: LocalInferenceTranslation[];
};

export class LocalInferenceInputError extends Error {
  readonly code = 'LOCAL_INFERENCE_INVALID' as const;

  constructor(message = 'Browser-local inference payload is invalid.') {
    super(message);
    this.name = 'LocalInferenceInputError';
  }
}

function invalid(): never {
  throw new LocalInferenceInputError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function exactModelTuple(
  value: unknown,
  expected: typeof LOCAL_INFERENCE_ASR | typeof LOCAL_INFERENCE_TRANSLATION,
): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['provider', 'model', 'revision'])) return false;
  return value.provider === expected.provider
    && value.model === expected.model
    && value.revision === expected.revision;
}

function normalizedText(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > LOCAL_INFERENCE_MAX_TEXT_CHARS) invalid();
  return normalized;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function browserLocalSpeakerId(projectId: string): string {
  return `browser-local:${projectId}:speaker-1`;
}

export function normalizeClientInferenceInput(projectId: string, payload: unknown): ClientInferenceInput {
  if (typeof projectId !== 'string' || !projectId.trim()) invalid();
  if (!isRecord(payload) || !hasOnlyKeys(payload, [
    'expectedSourceGeneration',
    'expectedSourceObjectKey',
    'durationMs',
    'asr',
    'translation',
    'segments',
    'translations',
  ])) invalid();

  const expectedSourceGeneration = payload.expectedSourceGeneration;
  if (!positiveInteger(expectedSourceGeneration)) invalid();

  const expectedSourceObjectKey = payload.expectedSourceObjectKey;
  if (typeof expectedSourceObjectKey !== 'string' || !expectedSourceObjectKey.trim()) invalid();

  const durationMs = payload.durationMs;
  if (!positiveInteger(durationMs) || durationMs > LOCAL_INFERENCE_MAX_DURATION_MS) invalid();

  if (!exactModelTuple(payload.asr, LOCAL_INFERENCE_ASR)) invalid();
  if (!exactModelTuple(payload.translation, LOCAL_INFERENCE_TRANSLATION)) invalid();

  if (!Array.isArray(payload.segments)
      || payload.segments.length < 1
      || payload.segments.length > LOCAL_INFERENCE_MAX_SEGMENTS) invalid();

  const segments: LocalInferenceSegment[] = [];
  const segmentIds = new Set<string>();
  let previousEndMs = 0;

  for (const raw of payload.segments) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ['id', 'startMs', 'endMs', 'sourceText'])) invalid();
    const id = normalizedText(raw.id);
    if (segmentIds.has(id)) invalid();

    const startMs = raw.startMs;
    const endMs = raw.endMs;
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) invalid();
    if (Number(startMs) < 0 || Number(endMs) <= Number(startMs)) invalid();
    if (Number(endMs) - Number(startMs) < LOCAL_INFERENCE_MIN_SEGMENT_MS) invalid();
    if (Number(startMs) < previousEndMs || Number(endMs) > durationMs) invalid();

    const sourceText = normalizedText(raw.sourceText);
    segments.push({ id, startMs: Number(startMs), endMs: Number(endMs), sourceText });
    segmentIds.add(id);
    previousEndMs = Number(endMs);
  }

  if (!Array.isArray(payload.translations) || payload.translations.length !== segments.length) invalid();
  const translations: LocalInferenceTranslation[] = [];
  const translatedIds = new Set<string>();

  for (const raw of payload.translations) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ['segmentId', 'translatedText'])) invalid();
    const segmentId = normalizedText(raw.segmentId);
    if (!segmentIds.has(segmentId) || translatedIds.has(segmentId)) invalid();
    translations.push({ segmentId, translatedText: normalizedText(raw.translatedText) });
    translatedIds.add(segmentId);
  }

  if (translatedIds.size !== segmentIds.size) invalid();

  return {
    expectedSourceGeneration,
    expectedSourceObjectKey,
    durationMs,
    asr: LOCAL_INFERENCE_ASR,
    translation: LOCAL_INFERENCE_TRANSLATION,
    segments,
    translations,
  };
}
