import { AsrError } from './types';
import {
  normalizeAsrChunks,
  stableHash,
  type AsrChunkForNormalization,
  type NormalizedAsrSegment,
} from './normalize';

const MAX_BOUNDARY_DELTA_MS = 1500;
const MIN_TEMPORAL_INTERSECTION_RATIO = 0.5;

type SpeakerKey = string;

type DuplicateCandidate = {
  left: NormalizedAsrSegment;
  right: NormalizedAsrSegment;
};

function normalizeTranscriptText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('und');
}

function temporalIntersectionRatio(left: NormalizedAsrSegment, right: NormalizedAsrSegment): number {
  const intersection = Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
  const shorter = Math.min(left.endMs - left.startMs, right.endMs - right.startMs);
  return shorter > 0 ? intersection / shorter : 0;
}

function isDuplicateCandidate(left: NormalizedAsrSegment, right: NormalizedAsrSegment): boolean {
  const leftText = normalizeTranscriptText(left.text);
  const rightText = normalizeTranscriptText(right.text);
  if (!leftText || leftText !== rightText) return false;
  if (Math.abs(left.startMs - right.startMs) > MAX_BOUNDARY_DELTA_MS) return false;
  if (Math.abs(left.endMs - right.endMs) > MAX_BOUNDARY_DELTA_MS) return false;
  return temporalIntersectionRatio(left, right) >= MIN_TEMPORAL_INTERSECTION_RATIO;
}

function speakerKey(segment: NormalizedAsrSegment): SpeakerKey | undefined {
  if (segment.speakerIndex === undefined) return undefined;
  return `${segment.chunkId}:${segment.speakerIndex}`;
}

function addCandidate(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from) ?? new Set<string>();
  set.add(to);
  map.set(from, set);
}

function onlyValue(values: Set<string> | undefined): string | undefined {
  if (!values || values.size !== 1) return undefined;
  return values.values().next().value as string | undefined;
}

class SpeakerUnion {
  private readonly parent = new Map<SpeakerKey, SpeakerKey>();

  add(key: SpeakerKey): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: SpeakerKey): SpeakerKey {
    this.add(key);
    const parent = this.parent.get(key)!;
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(left: SpeakerKey, right: SpeakerKey): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [canonicalRoot, otherRoot] = leftRoot.localeCompare(rightRoot) <= 0
      ? [leftRoot, rightRoot]
      : [rightRoot, leftRoot];
    this.parent.set(otherRoot, canonicalRoot);
  }
}

function uniqueDuplicatePairs(
  leftSegments: NormalizedAsrSegment[],
  rightSegments: NormalizedAsrSegment[],
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  const leftMatches = new Map<string, Set<string>>();
  const rightMatches = new Map<string, Set<string>>();

  for (const left of leftSegments) {
    for (const right of rightSegments) {
      if (!isDuplicateCandidate(left, right)) continue;
      candidates.push({ left, right });
      addCandidate(leftMatches, left.id, right.id);
      addCandidate(rightMatches, right.id, left.id);
    }
  }

  return candidates.filter(({ left, right }) =>
    onlyValue(leftMatches.get(left.id)) === right.id &&
    onlyValue(rightMatches.get(right.id)) === left.id,
  );
}

export function stitchAsrChunks(chunks: AsrChunkForNormalization[]): NormalizedAsrSegment[] {
  if (chunks.length === 0) return [];

  const projectIds = new Set(chunks.map((chunk) => chunk.projectId));
  if (projectIds.size !== 1) {
    throw new AsrError('ASR_PROJECT_INVALID', 'ASR chunks must belong to one project.');
  }
  const chunkIds = new Set(chunks.map((chunk) => chunk.chunkId));
  if (chunkIds.size !== chunks.length) {
    throw new AsrError('ASR_CHUNK_INVALID', 'ASR chunk identities must be unique.');
  }

  const normalized = normalizeAsrChunks(chunks);
  const orderedChunks = [...chunks].sort((left, right) =>
    left.offsetMs - right.offsetMs || left.chunkId.localeCompare(right.chunkId),
  );
  const segmentsByChunk = new Map<string, NormalizedAsrSegment[]>();
  for (const segment of normalized) {
    const list = segmentsByChunk.get(segment.chunkId) ?? [];
    list.push(segment);
    segmentsByChunk.set(segment.chunkId, list);
  }

  const duplicateLaterIds = new Set<string>();
  const forwardSpeakerCandidates = new Map<SpeakerKey, Set<SpeakerKey>>();
  const reverseSpeakerCandidates = new Map<SpeakerKey, Set<SpeakerKey>>();

  for (let index = 0; index + 1 < orderedChunks.length; index += 1) {
    const leftChunk = orderedChunks[index];
    const rightChunk = orderedChunks[index + 1];
    const pairs = uniqueDuplicatePairs(
      segmentsByChunk.get(leftChunk.chunkId) ?? [],
      segmentsByChunk.get(rightChunk.chunkId) ?? [],
    );

    for (const { left, right } of pairs) {
      duplicateLaterIds.add(right.id);
      const leftSpeaker = speakerKey(left);
      const rightSpeaker = speakerKey(right);
      if (leftSpeaker === undefined || rightSpeaker === undefined) continue;
      addCandidate(forwardSpeakerCandidates, leftSpeaker, rightSpeaker);
      addCandidate(reverseSpeakerCandidates, rightSpeaker, leftSpeaker);
    }
  }

  const union = new SpeakerUnion();
  for (const segment of normalized) {
    const key = speakerKey(segment);
    if (key !== undefined) union.add(key);
  }

  for (const [leftSpeaker, candidates] of forwardSpeakerCandidates) {
    const rightSpeaker = onlyValue(candidates);
    if (!rightSpeaker) continue;
    if (onlyValue(reverseSpeakerCandidates.get(rightSpeaker)) !== leftSpeaker) continue;
    union.union(leftSpeaker, rightSpeaker);
  }

  const membersByRoot = new Map<SpeakerKey, SpeakerKey[]>();
  for (const segment of normalized) {
    const key = speakerKey(segment);
    if (key === undefined) continue;
    const root = union.find(key);
    const members = membersByRoot.get(root) ?? [];
    if (!members.includes(key)) members.push(key);
    membersByRoot.set(root, members);
  }
  const canonicalByRoot = new Map<SpeakerKey, SpeakerKey>();
  for (const [root, members] of membersByRoot) {
    canonicalByRoot.set(root, [...members].sort((left, right) => left.localeCompare(right))[0]);
  }

  return normalized
    .filter((segment) => !duplicateLaterIds.has(segment.id))
    .map((segment) => {
      const key = speakerKey(segment);
      if (key === undefined) return segment;
      const root = union.find(key);
      const canonical = canonicalByRoot.get(root) ?? key;
      return {
        ...segment,
        speakerId: `spk_${stableHash(`${segment.projectId}:${canonical}`)}`,
      };
    })
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id));
}
