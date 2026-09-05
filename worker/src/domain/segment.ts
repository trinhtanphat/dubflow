export type SegmentPatch = {
  sourceText?: string;
  translatedText?: string;
  speakerId?: string | null;
  startMs?: number;
  endMs?: number;
};

export class SegmentInputError extends Error {
  readonly code = 'INVALID_SEGMENT_PATCH';
  constructor(message: string) {
    super(message);
    this.name = 'SegmentInputError';
  }
}

const ALLOWED = new Set(['sourceText', 'translatedText', 'speakerId', 'startMs', 'endMs']);

export function normalizeSegmentPatch(input: unknown, current: { startMs: number; endMs: number }): SegmentPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SegmentInputError('Segment patch must be an object.');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!ALLOWED.has(key)) throw new SegmentInputError(`Field ${key} is immutable or unsupported.`);
  const patch: SegmentPatch = {};
  if ('sourceText' in record) {
    if (typeof record.sourceText !== 'string') throw new SegmentInputError('sourceText must be a string.');
    patch.sourceText = record.sourceText;
  }
  if ('translatedText' in record) {
    if (typeof record.translatedText !== 'string') throw new SegmentInputError('translatedText must be a string.');
    patch.translatedText = record.translatedText;
  }
  if ('speakerId' in record) {
    if (record.speakerId !== null && typeof record.speakerId !== 'string') throw new SegmentInputError('speakerId must be a string or null.');
    patch.speakerId = record.speakerId as string | null;
  }
  if ('startMs' in record) {
    if (!Number.isInteger(record.startMs) || (record.startMs as number) < 0) throw new SegmentInputError('startMs must be a non-negative integer.');
    patch.startMs = record.startMs as number;
  }
  if ('endMs' in record) {
    if (!Number.isInteger(record.endMs) || (record.endMs as number) < 1) throw new SegmentInputError('endMs must be a positive integer.');
    patch.endMs = record.endMs as number;
  }
  const startMs = patch.startMs ?? current.startMs;
  const endMs = patch.endMs ?? current.endMs;
  if (endMs <= startMs) throw new SegmentInputError('endMs must be greater than startMs.');
  return patch;
}
