import { clamp, clampPixelsPerSecond } from './math';
import type { Segment } from './types';

export const MIN_SEGMENT_MS = 100;
export const SNAP_THRESHOLD_PX = 8;

export type SegmentTiming = { startMs: number; endMs: number };
export type TimingNeighbors = { previousEndMs: number; nextStartMs: number };
export type ResizeEdge = 'left' | 'right';
export type SnapKind = 'neighbor' | 'playhead' | 'grid';
export type SnapCandidate = { timeMs: number; kind: SnapKind };
export type SplitSegmentDraft = {
  left: Segment;
  right: Omit<Segment, 'id' | 'version'>;
};

const SNAP_PRIORITY: Record<SnapKind, number> = {
  neighbor: 0,
  playhead: 1,
  grid: 2,
};

function finiteMs(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

export function clampMoveTiming(
  current: SegmentTiming,
  deltaMs: number,
  neighbors: TimingNeighbors,
  durationMs: number,
): SegmentTiming {
  const duration = Math.max(MIN_SEGMENT_MS, current.endMs - current.startMs);
  const projectEnd = Math.max(duration, finiteMs(durationMs));
  const minStart = Math.max(0, finiteMs(neighbors.previousEndMs));
  const maxStart = Math.min(
    projectEnd - duration,
    finiteMs(neighbors.nextStartMs, projectEnd) - duration,
  );
  if (maxStart < minStart) return { ...current };
  const targetStart = finiteMs(current.startMs + finiteMs(deltaMs));
  const startMs = Math.round(clamp(targetStart, minStart, maxStart));
  return { startMs, endMs: startMs + duration };
}

export function clampResizeTiming(
  current: SegmentTiming,
  edge: ResizeEdge,
  targetMs: number,
  neighbors: TimingNeighbors,
  durationMs: number,
): SegmentTiming {
  const projectEnd = Math.max(0, finiteMs(durationMs));
  if (edge === 'left') {
    const minStart = Math.max(0, finiteMs(neighbors.previousEndMs));
    const maxStart = current.endMs - MIN_SEGMENT_MS;
    return {
      startMs: Math.round(clamp(finiteMs(targetMs), minStart, maxStart)),
      endMs: current.endMs,
    };
  }

  const minEnd = current.startMs + MIN_SEGMENT_MS;
  const maxEnd = Math.min(projectEnd, finiteMs(neighbors.nextStartMs, projectEnd));
  return {
    startMs: current.startMs,
    endMs: Math.round(clamp(finiteMs(targetMs), minEnd, maxEnd)),
  };
}

export function snapEdgeTime(
  targetMs: number,
  candidates: SnapCandidate[],
  pixelsPerSecond: number,
): number {
  const target = finiteMs(targetMs);
  const zoom = clampPixelsPerSecond(pixelsPerSecond);
  const ranked = candidates
    .filter((candidate) => Number.isFinite(candidate.timeMs))
    .map((candidate) => ({
      ...candidate,
      timeMs: finiteMs(candidate.timeMs),
      distancePx: Math.abs(candidate.timeMs - target) / 1000 * zoom,
    }))
    .filter((candidate) => candidate.distancePx <= SNAP_THRESHOLD_PX)
    .sort((left, right) =>
      left.distancePx - right.distancePx
      || SNAP_PRIORITY[left.kind] - SNAP_PRIORITY[right.kind]
      || left.timeMs - right.timeMs,
    );
  return ranked[0]?.timeMs ?? target;
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

export function splitSegmentDraft(segment: Segment, playheadMs: number): SplitSegmentDraft {
  const playhead = finiteMs(playheadMs);
  if (playhead - segment.startMs < MIN_SEGMENT_MS || segment.endMs - playhead < MIN_SEGMENT_MS) {
    throw new RangeError(`Split point must leave at least ${MIN_SEGMENT_MS} ms on both sides.`);
  }

  const ratio = (playhead - segment.startMs) / (segment.endMs - segment.startMs);
  const source = splitTextAtRatio(segment.sourceText, ratio);
  const translated = splitTextAtRatio(segment.translatedText, ratio);

  return {
    left: {
      ...segment,
      endMs: playhead,
      sourceText: source.left,
      translatedText: translated.left,
    },
    right: {
      speakerId: segment.speakerId,
      startMs: playhead,
      endMs: segment.endMs,
      sourceText: source.right,
      translatedText: translated.right,
    },
  };
}