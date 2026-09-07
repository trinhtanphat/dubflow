import type { R2BucketLike, R2UploadedPartLike, R2UploadValue } from '../cloudflare/r2';
import type { ProjectStore } from '../db/projects';
import {
  normalizeUploadInput,
  type BeginUploadInput,
  type NormalizedUploadInput,
  UploadInputError,
} from '../domain/upload';

export const MULTIPART_PART_SIZE_BYTES = 25 * 1024 * 1024;
export const PREPARED_ASR_MAX_CHUNK_DURATION_MS = 300_000;
export const PREPARED_ASR_MAX_CHUNK_BYTES = 10 * 1024 * 1024;

export type PreparedAsrChunkDescriptor = {
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
  chunks: PreparedAsrChunkDescriptor[];
};

type CompletePreparedAsrInput = {
  sourceGeneration?: number;
  durationMs?: number;
  chunks?: Array<{ index?: number; offsetMs?: number; durationMs?: number; sizeBytes?: number }>;
};

export class UploadServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UploadServiceError';
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function positiveInteger(value: unknown, code: string, message: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new UploadServiceError(code, message);
  return number;
}

function nonNegativeInteger(value: unknown, code: string, message: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new UploadServiceError(code, message);
  return number;
}

export class UploadService {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly projects: ProjectStore,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  private async requireProject(projectId: string, userId: string) {
    const project = await this.projects.getByIdForUser(projectId, userId);
    if (!project) throw new UploadServiceError('PROJECT_NOT_FOUND', 'Project not found.');
    return project;
  }

  private assertObjectKey(projectId: string, objectKey: string) {
    const prefix = `projects/${projectId}/source/`;
    if (!objectKey.startsWith(prefix) || objectKey.length <= prefix.length) {
      throw new UploadServiceError('UPLOAD_KEY_INVALID', 'Upload object key does not belong to this project.');
    }
  }

  private async requireCurrentSourceGeneration(projectId: string, userId: string, sourceGeneration: unknown) {
    const project = await this.requireProject(projectId, userId);
    const generation = positiveInteger(
      sourceGeneration,
      'PREPARED_ASR_GENERATION_INVALID',
      'Prepared ASR source generation must be a positive integer.',
    );
    if (!project.sourceObjectKey) {
      throw new UploadServiceError('PREPARED_ASR_SOURCE_MISSING', 'Project source media is missing.');
    }
    if (project.sourceGeneration !== generation) {
      throw new UploadServiceError('PREPARED_ASR_SOURCE_CHANGED', 'Project source generation changed before prepared audio was stored.');
    }
    return { project, sourceGeneration: generation };
  }

  private preparedPrefix(projectId: string, sourceGeneration: number): string {
    return `projects/${projectId}/asr/source-${sourceGeneration}/`;
  }

  private preparedChunkKey(projectId: string, sourceGeneration: number, index: number): string {
    return `${this.preparedPrefix(projectId, sourceGeneration)}chunk-${index}.wav`;
  }

  private preparedManifestKey(projectId: string, sourceGeneration: number): string {
    return `${this.preparedPrefix(projectId, sourceGeneration)}manifest.json`;
  }

  async validateBegin(projectId: string, userId: string, rawInput: BeginUploadInput): Promise<NormalizedUploadInput> {
    await this.requireProject(projectId, userId);
    try {
      return normalizeUploadInput(rawInput);
    } catch (error) {
      if (error instanceof UploadInputError) throw error;
      throw new UploadServiceError('UPLOAD_MEDIA_INVALID', 'Invalid media input.');
    }
  }

  async beginValidated(projectId: string, input: NormalizedUploadInput) {
    const objectKey = `projects/${projectId}/source/${this.createId()}.${input.extension}`;
    const multipart = await this.bucket.createMultipartUpload(objectKey);
    return {
      uploadId: multipart.uploadId,
      objectKey,
      partSizeBytes: MULTIPART_PART_SIZE_BYTES,
    };
  }

  async begin(projectId: string, userId: string, rawInput: BeginUploadInput) {
    return this.beginValidated(projectId, await this.validateBegin(projectId, userId, rawInput));
  }

  async uploadPart(
    projectId: string,
    userId: string,
    uploadId: string,
    objectKey: string,
    partNumber: number,
    body: R2UploadValue,
  ): Promise<R2UploadedPartLike> {
    await this.requireProject(projectId, userId);
    this.assertObjectKey(projectId, objectKey);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new UploadServiceError('UPLOAD_PART_INVALID', 'Part number must be an integer between 1 and 10000.');
    }
    if (!body) throw new UploadServiceError('UPLOAD_BODY_REQUIRED', 'Upload part body is required.');
    return this.bucket.resumeMultipartUpload(objectKey, uploadId).uploadPart(partNumber, body);
  }

  async complete(
    projectId: string,
    userId: string,
    uploadId: string,
    objectKey: string,
    parts: R2UploadedPartLike[],
  ) {
    await this.requireProject(projectId, userId);
    this.assertObjectKey(projectId, objectKey);
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new UploadServiceError('UPLOAD_PARTS_REQUIRED', 'At least one uploaded part is required.');
    }

    const seen = new Set<number>();
    const normalized = parts.map((part) => {
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10_000 || !part.etag?.trim()) {
        throw new UploadServiceError('UPLOAD_PART_INVALID', 'Each completed part requires a valid part number and ETag.');
      }
      if (seen.has(part.partNumber)) throw new UploadServiceError('UPLOAD_PART_DUPLICATE', 'Duplicate part number.');
      seen.add(part.partNumber);
      return { partNumber: part.partNumber, etag: part.etag };
    }).sort((a, b) => a.partNumber - b.partNumber);

    const object = await this.bucket.resumeMultipartUpload(objectKey, uploadId).complete(normalized);
    if (object.key !== objectKey) throw new UploadServiceError('UPLOAD_COMPLETE_MISMATCH', 'Completed R2 object key does not match upload key.');
    await this.projects.setSourceObject(projectId, userId, objectKey, object.size);
    return { objectKey, size: object.size };
  }

  async putPreparedAsrChunk(
    projectId: string,
    userId: string,
    sourceGeneration: unknown,
    indexValue: unknown,
    offsetValue: unknown,
    durationValue: unknown,
    wav: ArrayBuffer,
  ): Promise<PreparedAsrChunkDescriptor> {
    const { sourceGeneration: generation } = await this.requireCurrentSourceGeneration(projectId, userId, sourceGeneration);
    const index = nonNegativeInteger(indexValue, 'PREPARED_ASR_CHUNK_INVALID', 'Prepared ASR chunk index is invalid.');
    const offsetMs = nonNegativeInteger(offsetValue, 'PREPARED_ASR_CHUNK_INVALID', 'Prepared ASR chunk offset is invalid.');
    const durationMs = positiveInteger(durationValue, 'PREPARED_ASR_CHUNK_INVALID', 'Prepared ASR chunk duration is invalid.');
    if (durationMs > PREPARED_ASR_MAX_CHUNK_DURATION_MS) {
      throw new UploadServiceError('PREPARED_ASR_CHUNK_INVALID', 'Prepared ASR chunk exceeds 300 seconds.');
    }
    if (!(wav instanceof ArrayBuffer) || wav.byteLength <= 44 || wav.byteLength > PREPARED_ASR_MAX_CHUNK_BYTES) {
      throw new UploadServiceError('PREPARED_ASR_CHUNK_INVALID', 'Prepared ASR WAV chunk size is invalid.');
    }
    const bytes = new Uint8Array(wav);
    if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
      throw new UploadServiceError('PREPARED_ASR_CHUNK_INVALID', 'Prepared ASR chunk must be a RIFF/WAVE file.');
    }
    if (!this.bucket.put) throw new UploadServiceError('R2_PUT_UNAVAILABLE', 'R2 put is unavailable.');

    const objectKey = this.preparedChunkKey(projectId, generation, index);
    const object = await this.bucket.put(objectKey, wav, { httpMetadata: { contentType: 'audio/wav' } });
    if (object.key !== objectKey) {
      throw new UploadServiceError('PREPARED_ASR_CHUNK_MISMATCH', 'Stored prepared ASR chunk key does not match the derived key.');
    }
    return { index, objectKey, offsetMs, durationMs, sizeBytes: object.size };
  }

  async completePreparedAsr(
    projectId: string,
    userId: string,
    input: CompletePreparedAsrInput,
  ): Promise<PreparedAsrManifest> {
    const { project, sourceGeneration } = await this.requireCurrentSourceGeneration(projectId, userId, input.sourceGeneration);
    const durationMs = positiveInteger(input.durationMs, 'PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR duration is invalid.');
    if (!Array.isArray(input.chunks) || input.chunks.length === 0) {
      throw new UploadServiceError('PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR manifest requires at least one chunk.');
    }
    if (!this.bucket.head || !this.bucket.put) {
      throw new UploadServiceError('R2_PREPARED_ASR_UNAVAILABLE', 'R2 head/put is unavailable for prepared ASR completion.');
    }

    const chunks: PreparedAsrChunkDescriptor[] = [];
    let expectedOffsetMs = 0;
    for (let position = 0; position < input.chunks.length; position += 1) {
      const raw = input.chunks[position];
      const index = nonNegativeInteger(raw.index, 'PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR chunk index is invalid.');
      if (index !== position) throw new UploadServiceError('PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR chunks must be contiguous from index zero.');
      const offsetMs = nonNegativeInteger(raw.offsetMs, 'PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR chunk offset is invalid.');
      const chunkDurationMs = positiveInteger(raw.durationMs, 'PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR chunk duration is invalid.');
      const declaredSizeBytes = positiveInteger(raw.sizeBytes, 'PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR chunk size is invalid.');
      if (offsetMs !== expectedOffsetMs || chunkDurationMs > PREPARED_ASR_MAX_CHUNK_DURATION_MS) {
        throw new UploadServiceError('PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR chunk timeline is not contiguous or bounded.');
      }

      const objectKey = this.preparedChunkKey(projectId, sourceGeneration, index);
      const stored = await this.bucket.head(objectKey);
      if (!stored || stored.size !== declaredSizeBytes || stored.size <= 44 || stored.size > PREPARED_ASR_MAX_CHUNK_BYTES) {
        throw new UploadServiceError('PREPARED_ASR_CHUNK_MISSING', `Prepared ASR chunk ${index} is missing or changed.`);
      }
      chunks.push({ index, objectKey, offsetMs, durationMs: chunkDurationMs, sizeBytes: stored.size });
      expectedOffsetMs += chunkDurationMs;
    }
    if (expectedOffsetMs !== durationMs) {
      throw new UploadServiceError('PREPARED_ASR_MANIFEST_INVALID', 'Prepared ASR manifest duration does not match its chunks.');
    }

    const manifest: PreparedAsrManifest = {
      version: 1,
      projectId,
      sourceObjectKey: project.sourceObjectKey!,
      sourceGeneration,
      sampleRate: 16000,
      channels: 1,
      sampleFormat: 's16',
      container: 'wav',
      durationMs,
      chunks,
    };
    const manifestKey = this.preparedManifestKey(projectId, sourceGeneration);
    const encoded = JSON.stringify(manifest);
    const storedManifest = await this.bucket.put(manifestKey, encoded, { httpMetadata: { contentType: 'application/json' } });
    if (storedManifest.key !== manifestKey) {
      throw new UploadServiceError('PREPARED_ASR_MANIFEST_MISMATCH', 'Stored prepared ASR manifest key does not match the derived key.');
    }
    return manifest;
  }
}
