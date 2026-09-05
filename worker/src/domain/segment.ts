export const MIN_SEGMENT_MS = 100;

export type SegmentPatch = {
  sourceText?: string;
  translatedText?: string;
  speakerId?: string | null;
  startMs?: number;
  endMs?: number;
};

export type SegmentRestoreInput = {
  sourceText: string;
  translatedText: string;
  speakerId: string | null;
  startMs: number;
  endMs: number;
};

export type PersistedAsrSegment = {
  id: string;
  startMs: number;
  endMs: number;
  sourceText: string;
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

export function normalizeSegmentRestoreInput(input: unknown, current: { startMs: number; endMs: number }): SegmentRestoreInput {
  const patch = normalizeSegmentPatch(input, current);
  if (patch.sourceText === undefined || patch.translatedText === undefined || patch.speakerId === undefined
    || patch.startMs === undefined || patch.endMs === undefined) {
    throw new SegmentInputError('Restore payload requires sourceText, translatedText, speakerId, startMs, and endMs.');
  }
  return patch as SegmentRestoreInput;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function splitTextAtRatio(text: string, ratio: number): { left: string; right: string } {
  const chars = Array.from(text);
  if (chars.length < 2) return { left: text.trim(), right: '' };

  const safeRatio = clamp(Number.isFinite(ratio) ? ratio : 0.5, 0, 1);
  const target = safeRatio * chars.length;
  const whitespaceBoundaries: number[] = [];
  for (let index = 1; index < chars.length; index += 1) {
    if (/\s/u.test(chars[index])) whitespaceBoundaries.push(index);
  }

  const splitIndex = whitespaceBoundaries.length > 0
    ? whitespaceBoundaries.reduce((best, candidate) => {
      const bestDistance = Math.abs(best - target);
      const candidateDistance = Math.abs(candidate - target);
      return candidateDistance < bestDistance ? candidate : best;
    })
    : Math.round(clamp(target, 1, chars.length - 1));

  return {
    left: chars.slice(0, splitIndex).join('').trim(),
    right: chars.slice(splitIndex).join('').trim(),
  };
}

export function normalizeAsrSegments(input: unknown): PersistedAsrSegment[] {
  if (!Array.isArray(input)) throw new SegmentInputError('ASR segments must be an array.');
  const seen = new Set<string>();
  const normalized = input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SegmentInputError(`ASR segment ${index} must be an object.`);
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.trim().length === 0) {
      throw new SegmentInputError(`ASR segment ${index} requires a non-empty id.`);
    }
    const id = record.id.trim();
    if (seen.has(id)) throw new SegmentInputError(`Duplicate ASR segment id: ${id}.`);
    seen.add(id);
    if (!Number.isInteger(record.startMs) || (record.startMs as number) < 0) {
      throw new SegmentInputError(`ASR segment ${id} startMs must be a non-negative integer.`);
    }
    if (!Number.isInteger(record.endMs) || (record.endMs as number) <= (record.startMs as number)) {
      throw new SegmentInputError(`ASR segment ${id} endMs must be greater than startMs.`);
    }
    if (typeof record.sourceText !== 'string') {
      throw new SegmentInputError(`ASR segment ${id} sourceText must be a string.`);
    }
    return {
      id,
      startMs: record.startMs as number,
      endMs: record.endMs as number,
      sourceText: record.sourceText,
    };
  });
  normalized.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
  return normalized;
}
