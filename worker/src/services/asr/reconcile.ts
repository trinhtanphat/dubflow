import type { StitchedAsrSegment } from './stitch';

export type ExistingSpeakerCoverage = {
  speakerId: string;
  ranges: Array<{ startMs: number; endMs: number }>;
};

type Claim = {
  freshSpeakerId: string;
  existingSpeakerId: string;
  overlapMs: number;
};

const MIN_EXISTING_SPEAKER_OVERLAP_MS = 2_000;

function intersectionMs(
  left: { startMs: number; endMs: number },
  right: { startMs: number; endMs: number },
): number {
  return Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
}

function validateCoverage(coverage: ExistingSpeakerCoverage): void {
  if (!coverage.speakerId.trim()) throw new Error('Existing speaker id is required.');
  for (const range of coverage.ranges) {
    if (!Number.isFinite(range.startMs) || !Number.isFinite(range.endMs) || range.endMs <= range.startMs) {
      throw new Error('Existing speaker coverage range is invalid.');
    }
  }
}

export function reconcileSpeakerIds(
  segments: StitchedAsrSegment[],
  existingCoverage: ExistingSpeakerCoverage[],
): StitchedAsrSegment[] {
  for (const coverage of existingCoverage) validateCoverage(coverage);

  const freshClusters = new Map<string, StitchedAsrSegment[]>();
  for (const segment of segments) {
    if (!segment.speakerId) continue;
    freshClusters.set(segment.speakerId, [...(freshClusters.get(segment.speakerId) ?? []), segment]);
  }

  const sortedCoverage = [...existingCoverage].sort((a, b) => a.speakerId.localeCompare(b.speakerId));
  const claims: Claim[] = [];
  for (const freshSpeakerId of [...freshClusters.keys()].sort()) {
    const cluster = freshClusters.get(freshSpeakerId)!;
    const scores = sortedCoverage.map((coverage) => ({
      existingSpeakerId: coverage.speakerId,
      overlapMs: cluster.reduce((total, segment) => total + coverage.ranges.reduce(
        (rangeTotal, range) => rangeTotal + intersectionMs(segment, range),
        0,
      ), 0),
    })).sort((a, b) => b.overlapMs - a.overlapMs || a.existingSpeakerId.localeCompare(b.existingSpeakerId));

    const best = scores[0];
    if (!best || best.overlapMs < MIN_EXISTING_SPEAKER_OVERLAP_MS) continue;
    if (scores.length > 1 && scores[1].overlapMs === best.overlapMs) continue;
    claims.push({ freshSpeakerId, existingSpeakerId: best.existingSpeakerId, overlapMs: best.overlapMs });
  }

  const claimsByExisting = new Map<string, Claim[]>();
  for (const claim of claims) {
    claimsByExisting.set(claim.existingSpeakerId, [...(claimsByExisting.get(claim.existingSpeakerId) ?? []), claim]);
  }

  const reuse = new Map<string, string>();
  for (const existingSpeakerId of [...claimsByExisting.keys()].sort()) {
    const competing = claimsByExisting.get(existingSpeakerId)!
      .sort((a, b) => b.overlapMs - a.overlapMs || a.freshSpeakerId.localeCompare(b.freshSpeakerId));
    if (competing.length > 1 && competing[0].overlapMs === competing[1].overlapMs) continue;
    reuse.set(competing[0].freshSpeakerId, existingSpeakerId);
  }

  return segments.map((segment) => segment.speakerId && reuse.has(segment.speakerId)
    ? { ...segment, speakerId: reuse.get(segment.speakerId)! }
    : segment);
}
