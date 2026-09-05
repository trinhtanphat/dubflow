import type { AsrSegment } from './types';
import { AsrError } from './types';

export type AsrChunkForNormalization = {
  projectId: string;
  chunkId: string;
  offsetMs: number;
  segments: AsrSegment[];
};

export type NormalizedAsrSegment = AsrSegment & { id: string; projectId: string; chunkId: string };

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function normalizeAsrChunks(chunks: AsrChunkForNormalization[]): NormalizedAsrSegment[] {
  const output: NormalizedAsrSegment[] = [];
  for (const chunk of chunks) {
    if (!Number.isFinite(chunk.offsetMs) || chunk.offsetMs < 0) throw new AsrError('ASR_OFFSET_INVALID', 'Chunk offset must be non-negative.');
    chunk.segments.forEach((segment, index) => {
      if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.endMs <= segment.startMs) {
        throw new AsrError('ASR_RANGE_INVALID', 'ASR segment end must be after start.');
      }
      if (segment.speakerIndex !== undefined && (!Number.isInteger(segment.speakerIndex) || segment.speakerIndex < 0)) {
        throw new AsrError('ASR_SPEAKER_INVALID', 'ASR speaker index must be a non-negative integer.');
      }
      const startMs = segment.startMs + chunk.offsetMs;
      const endMs = segment.endMs + chunk.offsetMs;
      const identity = `${chunk.projectId}:${chunk.chunkId}:${index}:${startMs}:${endMs}`;
      output.push({
        id: `seg_${stableHash(identity)}`,
        projectId: chunk.projectId,
        chunkId: chunk.chunkId,
        startMs,
        endMs,
        text: segment.text,
        ...(segment.speakerIndex === undefined ? {} : { speakerIndex: segment.speakerIndex }),
      });
    });
  }
  return output.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
}
