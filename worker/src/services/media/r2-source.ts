import { MAX_MEDIA_DURATION_SECONDS } from '../../../../shared/mediaPolicy';
import type { R2ReadableBucketLike } from '../../cloudflare/r2';
import { createMediaSourceToken } from '../../security/media-source-token';

const SOURCE_URL_TTL_SECONDS = 15 * 60;
const PREPARED_MANIFEST_MAX_BYTES = 1024 * 1024;
const PREPARED_CHUNK_MAX_DURATION_MS = 300_000;
const PREPARED_CHUNK_MAX_BYTES = 10 * 1024 * 1024;

type R2SourceProject = {
  id: string;
  sourceObjectKey?: string | null;
  sourceGeneration?: number;
  durationMs?: number | null;
};

type R2SourceProjectStore = {
  getByIdForUser(projectId: string, userId: string): Promise<R2SourceProject | null>;
};

type R2SourceMediaServiceDeps = {
  projects: R2SourceProjectStore;
  publicOrigin: string;
  signingSecret: string;
  bucket?: R2ReadableBucketLike;
  durationProbe?: (sourceObjectKey: string) => Promise<number | null>;
  nowSeconds?: () => number;
};

export type PreparedR2SourceChunk = {
  index: number;
  objectKey: string;
  offsetMs: number;
  durationMs: number;
  sizeBytes: number;
};

export type PreparedR2SourceManifest = {
  version: 1;
  projectId: string;
  sourceObjectKey: string;
  sourceGeneration: number;
  sampleRate: 16000;
  channels: 1;
  sampleFormat: 's16';
  container: 'wav';
  durationMs: number;
  chunks: PreparedR2SourceChunk[];
};

export type PreparedR2Source = {
  sourceId: string;
  durationMs: number | null;
  audioUrl: string;
  prepared?: PreparedR2SourceManifest;
};

function boundedDuration(value: number | null | undefined): number | null {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_MEDIA_DURATION_SECONDS * 1000) return null;
  return Math.round(duration);
}

function manifestKey(projectId: string, sourceGeneration: number): string {
  return `projects/${projectId}/asr/source-${sourceGeneration}/manifest.json`;
}

function chunkKey(projectId: string, sourceGeneration: number, index: number): string {
  return `projects/${projectId}/asr/source-${sourceGeneration}/chunk-${index}.wav`;
}

function integer(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export class R2SourceMediaService {
  private readonly nowSeconds: () => number;

  constructor(private readonly deps: R2SourceMediaServiceDeps) {
    this.nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async readPrepared(
    projectId: string,
    sourceGeneration: number,
    sourceObjectKey: string,
  ): Promise<PreparedR2SourceManifest | null> {
    if (!this.deps.bucket?.get) return null;
    const object = await this.deps.bucket.get(manifestKey(projectId, sourceGeneration));
    if (!object) return null;
    if (object.size <= 0 || object.size > PREPARED_MANIFEST_MAX_BYTES) {
      throw new Error('PREPARED_ASR_MANIFEST_INVALID: Prepared ASR manifest size is invalid.');
    }

    let raw: unknown;
    try {
      raw = await new Response(object.body).json();
    } catch {
      throw new Error('PREPARED_ASR_MANIFEST_INVALID: Prepared ASR manifest is not valid JSON.');
    }
    if (!raw || typeof raw !== 'object') {
      throw new Error('PREPARED_ASR_MANIFEST_INVALID: Prepared ASR manifest is invalid.');
    }
    const manifest = raw as Record<string, unknown>;
    const durationMs = boundedDuration(Number(manifest.durationMs));
    const generation = integer(manifest.sourceGeneration);
    if (
      manifest.version !== 1
      || manifest.projectId !== projectId
      || manifest.sourceObjectKey !== sourceObjectKey
      || generation !== sourceGeneration
      || manifest.sampleRate !== 16000
      || manifest.channels !== 1
      || manifest.sampleFormat !== 's16'
      || manifest.container !== 'wav'
      || durationMs === null
      || !Array.isArray(manifest.chunks)
      || manifest.chunks.length === 0
    ) {
      throw new Error('PREPARED_ASR_SOURCE_CHANGED: Prepared ASR manifest does not match the current project source.');
    }

    const chunks: PreparedR2SourceChunk[] = [];
    let expectedOffsetMs = 0;
    for (let index = 0; index < manifest.chunks.length; index += 1) {
      const rawChunk = manifest.chunks[index];
      if (!rawChunk || typeof rawChunk !== 'object') {
        throw new Error('PREPARED_ASR_MANIFEST_INVALID: Prepared ASR chunk descriptor is invalid.');
      }
      const chunk = rawChunk as Record<string, unknown>;
      const chunkIndex = integer(chunk.index);
      const offsetMs = integer(chunk.offsetMs);
      const chunkDurationMs = integer(chunk.durationMs);
      const sizeBytes = integer(chunk.sizeBytes);
      const expectedKey = chunkKey(projectId, sourceGeneration, index);
      if (
        chunkIndex !== index
        || chunk.objectKey !== expectedKey
        || offsetMs !== expectedOffsetMs
        || chunkDurationMs === null
        || chunkDurationMs <= 0
        || chunkDurationMs > PREPARED_CHUNK_MAX_DURATION_MS
        || sizeBytes === null
        || sizeBytes <= 44
        || sizeBytes > PREPARED_CHUNK_MAX_BYTES
      ) {
        throw new Error('PREPARED_ASR_MANIFEST_INVALID: Prepared ASR chunks are not contiguous, bounded, and canonical.');
      }
      chunks.push({ index, objectKey: expectedKey, offsetMs, durationMs: chunkDurationMs, sizeBytes });
      expectedOffsetMs += chunkDurationMs;
    }
    if (expectedOffsetMs !== durationMs) {
      throw new Error('PREPARED_ASR_MANIFEST_INVALID: Prepared ASR manifest duration does not match its chunks.');
    }

    return {
      version: 1,
      projectId,
      sourceObjectKey,
      sourceGeneration,
      sampleRate: 16000,
      channels: 1,
      sampleFormat: 's16',
      container: 'wav',
      durationMs,
      chunks,
    };
  }

  async prepareSource(projectId: string, userId: string, sourceObjectKey: string): Promise<PreparedR2Source> {
    const project = await this.deps.projects.getByIdForUser(projectId, userId);
    if (!project) throw new Error('MEDIA_SOURCE_NOT_FOUND: Project not found.');
    if (!sourceObjectKey || project.sourceObjectKey !== sourceObjectKey) {
      throw new Error('MEDIA_SOURCE_CHANGED: Project source media changed before transcription.');
    }

    const sourceGeneration = Number(project.sourceGeneration ?? 1);
    if (!Number.isInteger(sourceGeneration) || sourceGeneration < 1) {
      throw new Error('MEDIA_SOURCE_CHANGED: Project source generation is invalid.');
    }
    const prepared = await this.readPrepared(projectId, sourceGeneration, sourceObjectKey);

    const origin = this.deps.publicOrigin.trim();
    if (!origin) throw new Error('MEDIA_SOURCE_ORIGIN_UNAVAILABLE: Public origin is missing.');
    const secret = this.deps.signingSecret.trim();
    if (!secret) throw new Error('MEDIA_SOURCE_SIGNING_UNAVAILABLE: Media source signing secret is missing.');

    const storedDurationMs = boundedDuration(prepared?.durationMs ?? project.durationMs);
    const probedDurationMs = storedDurationMs === null && this.deps.durationProbe
      ? boundedDuration(await this.deps.durationProbe(sourceObjectKey))
      : null;

    const expires = this.nowSeconds() + SOURCE_URL_TTL_SECONDS;
    const signature = await createMediaSourceToken(secret, projectId, sourceObjectKey, expires);
    const url = new URL(`/api/media-source/${encodeURIComponent(projectId)}`, origin);
    url.searchParams.set('key', sourceObjectKey);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);

    return {
      sourceId: sourceObjectKey,
      durationMs: storedDurationMs ?? probedDurationMs,
      audioUrl: url.toString(),
      prepared: prepared ?? undefined,
    };
  }
}
