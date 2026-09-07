import { apiFetch } from '../../lib/api/client';
import type { PreparedAsrChunk } from './sourceAudioPrep';

export type StoredPreparedAsrChunk = {
  index: number;
  objectKey: string;
  offsetMs: number;
  durationMs: number;
  sizeBytes: number;
};

export type PreparedAsrManifest = {
  version: 1;
  projectId: string;
  sourceObjectKey: string;
  sourceGeneration: number;
  sampleRate: 16000;
  channels: 1;
  sampleFormat: 's16';
  container: 'wav';
  durationMs: number;
  chunks: StoredPreparedAsrChunk[];
};

function positiveGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('Source generation must be a positive integer.');
  return value;
}

export async function uploadPreparedAsrChunk(
  projectId: string,
  sourceGeneration: number,
  chunk: PreparedAsrChunk,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredPreparedAsrChunk> {
  positiveGeneration(sourceGeneration);
  if (!Number.isInteger(chunk.index) || chunk.index < 0) throw new Error('Prepared ASR chunk index is invalid.');
  if (!Number.isFinite(chunk.offsetMs) || chunk.offsetMs < 0) throw new Error('Prepared ASR chunk offset is invalid.');
  if (!Number.isFinite(chunk.durationMs) || chunk.durationMs <= 0 || chunk.durationMs > 300_000) {
    throw new Error('Prepared ASR chunk duration is invalid.');
  }
  if (!(chunk.wav instanceof ArrayBuffer) || chunk.wav.byteLength <= 44) {
    throw new Error('Prepared ASR WAV chunk is empty.');
  }

  const query = new URLSearchParams({
    sourceGeneration: String(sourceGeneration),
    offsetMs: String(Math.round(chunk.offsetMs)),
    durationMs: String(Math.round(chunk.durationMs)),
  });
  const response = await fetchImpl(
    `/api/projects/${encodeURIComponent(projectId)}/uploads/asr/chunks/${chunk.index}?${query}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'audio/wav' },
      body: chunk.wav,
    },
  );
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(failure.message ?? `Prepared ASR chunk upload failed (${response.status}).`);
  }
  return response.json() as Promise<StoredPreparedAsrChunk>;
}

export async function completePreparedAsrUpload(
  projectId: string,
  sourceGeneration: number,
  durationMs: number,
  chunks: StoredPreparedAsrChunk[],
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedAsrManifest> {
  positiveGeneration(sourceGeneration);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Prepared ASR duration is invalid.');
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('Prepared ASR chunks are required.');

  return apiFetch<PreparedAsrManifest>(
    `/api/projects/${encodeURIComponent(projectId)}/uploads/asr/complete`,
    {
      method: 'POST',
      body: JSON.stringify({
        sourceGeneration,
        durationMs: Math.round(durationMs),
        chunks: chunks.map(({ index, offsetMs, durationMs: chunkDurationMs, sizeBytes }) => ({
          index,
          offsetMs,
          durationMs: chunkDurationMs,
          sizeBytes,
        })),
      }),
    },
    fetchImpl,
  );
}
