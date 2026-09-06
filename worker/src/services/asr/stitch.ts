import type { AsrSegment } from './types';
import { AsrError } from './types';
import { stableHash } from './stable-hash';

export type StitchChunk = {
  projectId: string;
  chunkId: string;
  chunkOrder: number;
  offsetMs: number;
  overlapBeforeMs: number;
  overlapAfterMs: number;
  segments: AsrSegment[];
};

export type StitchedAsrSegment = {
  id: string;
  projectId: string;
  chunkId: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerIndex?: number;
  speakerId: string | null;
};

type Observation = {
  uid: string;
  projectId: string;
  chunkId: string;
  chunkOrder: number;
  localSegmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  normalizedText: string;
  speakerIndex?: number;
  localSpeakerKey?: string;
};

type EdgeScore = {
  leftKey: string;
  rightKey: string;
  matchCount: number;
  matchedDurationMs: number;
};

const MAX_DUPLICATE_EDGE_DELTA_MS = 1_500;
const MIN_SPEAKER_MATCH_DURATION_MS = 750;

function normalizeOverlapText(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .replace(/[\p{P}\p{S}]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function assertChunk(chunk: StitchChunk): void {
  if (!chunk.projectId.trim() || !chunk.chunkId.trim()) {
    throw new AsrError('ASR_CHUNK_INVALID', 'ASR stitching chunk identity is required.');
  }
  if (!Number.isInteger(chunk.chunkOrder) || chunk.chunkOrder < 0) {
    throw new AsrError('ASR_CHUNK_INVALID', 'ASR stitching chunk order must be a non-negative integer.');
  }
  if (!Number.isInteger(chunk.offsetMs) || chunk.offsetMs < 0) {
    throw new AsrError('ASR_OFFSET_INVALID', 'Chunk offset must be a non-negative integer.');
  }
  for (const overlap of [chunk.overlapBeforeMs, chunk.overlapAfterMs]) {
    if (!Number.isInteger(overlap) || overlap < 0) {
      throw new AsrError('ASR_CHUNK_INVALID', 'Chunk overlap must be a non-negative integer.');
    }
  }
}

function toObservations(chunks: StitchChunk[]): { sortedChunks: StitchChunk[]; observations: Observation[] } {
  if (chunks.length === 0) return { sortedChunks: [], observations: [] };
  const projectId = chunks[0].projectId;
  for (const chunk of chunks) {
    assertChunk(chunk);
    if (chunk.projectId !== projectId) {
      throw new AsrError('ASR_CHUNK_INVALID', 'ASR stitching cannot mix projects.');
    }
  }
  const sortedChunks = [...chunks].sort((a, b) =>
    a.chunkOrder - b.chunkOrder || a.offsetMs - b.offsetMs || a.chunkId.localeCompare(b.chunkId),
  );
  const observations: Observation[] = [];
  for (const chunk of sortedChunks) {
    chunk.segments.forEach((segment, localSegmentIndex) => {
      if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.endMs <= segment.startMs) {
        throw new AsrError('ASR_RANGE_INVALID', 'ASR segment end must be after start.');
      }
      if (segment.speakerIndex !== undefined && (!Number.isInteger(segment.speakerIndex) || segment.speakerIndex < 0)) {
        throw new AsrError('ASR_SPEAKER_INVALID', 'ASR speaker index must be a non-negative integer.');
      }
      const startMs = Math.round(chunk.offsetMs + segment.startMs);
      const endMs = Math.round(chunk.offsetMs + segment.endMs);
      observations.push({
        uid: `${chunk.chunkOrder}:${chunk.chunkId}:${localSegmentIndex}`,
        projectId: chunk.projectId,
        chunkId: chunk.chunkId,
        chunkOrder: chunk.chunkOrder,
        localSegmentIndex,
        startMs,
        endMs,
        text: segment.text,
        normalizedText: normalizeOverlapText(segment.text),
        ...(segment.speakerIndex === undefined ? {} : {
          speakerIndex: segment.speakerIndex,
          localSpeakerKey: `${chunk.chunkId}:${segment.speakerIndex}`,
        }),
      });
    });
  }
  return { sortedChunks, observations };
}

function intervalIntersectionMs(a: Observation, b: Observation): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

function intersectsWindow(observation: Observation, startMs: number, endMs: number): boolean {
  return observation.startMs < endMs && observation.endMs > startMs;
}

function numericScoreCompare(a: EdgeScore, b: EdgeScore): number {
  return b.matchCount - a.matchCount || b.matchedDurationMs - a.matchedDurationMs;
}

function scoreEqual(a: EdgeScore, b: EdgeScore): boolean {
  return a.matchCount === b.matchCount && a.matchedDurationMs === b.matchedDurationMs;
}

function uniqueBest(candidates: EdgeScore[], oppositeKey: (edge: EdgeScore) => string): EdgeScore | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => numericScoreCompare(a, b) || oppositeKey(a).localeCompare(oppositeKey(b)));
  if (sorted.length > 1 && scoreEqual(sorted[0], sorted[1])) return null;
  return sorted[0];
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    this.add(value);
    const parent = this.parent.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    if (rootA.localeCompare(rootB) <= 0) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }
}

function compareObservation(a: Observation, b: Observation): number {
  return a.startMs - b.startMs
    || a.endMs - b.endMs
    || a.chunkOrder - b.chunkOrder
    || a.localSegmentIndex - b.localSegmentIndex
    || a.chunkId.localeCompare(b.chunkId);
}

export function stitchAsrChunks(chunks: StitchChunk[]): StitchedAsrSegment[] {
  const { sortedChunks, observations } = toObservations(chunks);
  if (sortedChunks.length === 0) return [];

  const byChunk = new Map<string, Observation[]>();
  for (const observation of observations) {
    const items = byChunk.get(observation.chunkId) ?? [];
    items.push(observation);
    byChunk.set(observation.chunkId, items);
  }

  const dropped = new Set<string>();
  const edges = new Map<string, EdgeScore>();

  for (let boundary = 0; boundary < sortedChunks.length - 1; boundary += 1) {
    const left = sortedChunks[boundary];
    const right = sortedChunks[boundary + 1];
    const overlapMs = Math.min(left.overlapAfterMs, right.overlapBeforeMs);
    if (overlapMs <= 0) continue;
    const sharedStartMs = right.offsetMs;
    const sharedEndMs = sharedStartMs + overlapMs;
    const leftItems = (byChunk.get(left.chunkId) ?? []).filter((item) => intersectsWindow(item, sharedStartMs, sharedEndMs));
    const rightItems = (byChunk.get(right.chunkId) ?? []).filter((item) => intersectsWindow(item, sharedStartMs, sharedEndMs));

    const candidates: Array<{ left: Observation; right: Observation; intersectionMs: number; delta: number }> = [];
    for (const leftItem of leftItems) {
      if (!leftItem.normalizedText) continue;
      for (const rightItem of rightItems) {
        if (!rightItem.normalizedText || leftItem.normalizedText !== rightItem.normalizedText) continue;
        const intersectionMs = intervalIntersectionMs(leftItem, rightItem);
        if (intersectionMs <= 0) continue;
        const startDelta = Math.abs(leftItem.startMs - rightItem.startMs);
        const endDelta = Math.abs(leftItem.endMs - rightItem.endMs);
        if (startDelta > MAX_DUPLICATE_EDGE_DELTA_MS || endDelta > MAX_DUPLICATE_EDGE_DELTA_MS) continue;
        candidates.push({ left: leftItem, right: rightItem, intersectionMs, delta: startDelta + endDelta });
      }
    }

    candidates.sort((a, b) => a.delta - b.delta
      || compareObservation(a.left, b.left)
      || compareObservation(a.right, b.right));
    const pairedLeft = new Set<string>();
    const pairedRight = new Set<string>();
    for (const pair of candidates) {
      if (pairedLeft.has(pair.left.uid) || pairedRight.has(pair.right.uid)) continue;
      pairedLeft.add(pair.left.uid);
      pairedRight.add(pair.right.uid);
      dropped.add(pair.right.uid);
      if (!pair.left.localSpeakerKey || !pair.right.localSpeakerKey) continue;
      const edgeKey = `${boundary}\u0000${pair.left.localSpeakerKey}\u0000${pair.right.localSpeakerKey}`;
      const current = edges.get(edgeKey) ?? {
        leftKey: pair.left.localSpeakerKey,
        rightKey: pair.right.localSpeakerKey,
        matchCount: 0,
        matchedDurationMs: 0,
      };
      current.matchCount += 1;
      current.matchedDurationMs += pair.intersectionMs;
      edges.set(edgeKey, current);
    }
  }

  const union = new UnionFind();
  for (const observation of observations) {
    if (observation.localSpeakerKey) union.add(observation.localSpeakerKey);
  }

  for (let boundary = 0; boundary < sortedChunks.length - 1; boundary += 1) {
    const boundaryPrefix = `${boundary}\u0000`;
    const qualified = [...edges.entries()]
      .filter(([key, edge]) => key.startsWith(boundaryPrefix) && edge.matchCount >= 1 && edge.matchedDurationMs >= MIN_SPEAKER_MATCH_DURATION_MS)
      .map(([, edge]) => edge);
    const leftGroups = new Map<string, EdgeScore[]>();
    const rightGroups = new Map<string, EdgeScore[]>();
    for (const edge of qualified) {
      leftGroups.set(edge.leftKey, [...(leftGroups.get(edge.leftKey) ?? []), edge]);
      rightGroups.set(edge.rightKey, [...(rightGroups.get(edge.rightKey) ?? []), edge]);
    }
    for (const edge of qualified) {
      const leftBest = uniqueBest(leftGroups.get(edge.leftKey) ?? [], (candidate) => candidate.rightKey);
      const rightBest = uniqueBest(rightGroups.get(edge.rightKey) ?? [], (candidate) => candidate.leftKey);
      if (leftBest === edge && rightBest === edge) union.union(edge.leftKey, edge.rightKey);
    }
  }

  const clusterObservations = new Map<string, Observation[]>();
  for (const observation of observations) {
    if (!observation.localSpeakerKey) continue;
    const root = union.find(observation.localSpeakerKey);
    clusterObservations.set(root, [...(clusterObservations.get(root) ?? []), observation]);
  }
  const clusterSpeakerIds = new Map<string, string>();
  for (const [root, items] of clusterObservations) {
    const canonical = [...items].sort(compareObservation)[0];
    const canonicalKey = canonical.localSpeakerKey!;
    clusterSpeakerIds.set(root, `spk_${stableHash(`${canonical.projectId}:${canonicalKey}`)}`);
  }

  return observations
    .filter((observation) => !dropped.has(observation.uid))
    .map((observation): StitchedAsrSegment => {
      const identity = `${observation.projectId}:${observation.chunkId}:${observation.localSegmentIndex}:${observation.startMs}:${observation.endMs}`;
      const speakerId = observation.localSpeakerKey
        ? clusterSpeakerIds.get(union.find(observation.localSpeakerKey)) ?? null
        : null;
      return {
        id: `seg_${stableHash(identity)}`,
        projectId: observation.projectId,
        chunkId: observation.chunkId,
        startMs: observation.startMs,
        endMs: observation.endMs,
        text: observation.text,
        ...(observation.speakerIndex === undefined ? {} : { speakerIndex: observation.speakerIndex }),
        speakerId,
      };
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
}
