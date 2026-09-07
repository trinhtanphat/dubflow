import { describe, expect, it } from 'vitest';
import type { R2BucketLike, R2MultipartUploadLike, R2UploadedPartLike, R2UploadValue } from '../src/cloudflare/r2';
import type { Project, ProjectStatus, ProjectStore } from '../src/db/projects';
import { normalizeUploadInput, UploadInputError } from '../src/domain/upload';
import { UploadService } from '../src/services/uploads';

class MemoryProjectStore implements ProjectStore {
  project: Project = {
    id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh', targetLanguage: 'vi', targetLanguagesRevision: 1, sourceGeneration: 1, status: 'draft',
  };
  saved?: { key: string; size: number };
  async create(): Promise<Project> { return this.project; }
  async listByUser(): Promise<Project[]> { return [this.project]; }
  async getByIdForUser(id: string, userId: string): Promise<Project | null> {
    return id === this.project.id && userId === this.project.userId ? this.project : null;
  }
  async setSourceObject(_id: string, _userId: string, objectKey: string, sizeBytes: number) {
    this.saved = { key: objectKey, size: sizeBytes };
    this.project.sourceObjectKey = objectKey;
    this.project.sizeBytes = sizeBytes;
    this.project.status = 'ready';
  }
  async setExportObject(_id: string, _userId: string, objectKey: string) {
    this.project.exportObjectKey = objectKey;
  }
  async setStatus(_id: string, _userId: string, status: ProjectStatus, durationMs?: number) {
    this.project.status = status;
    if (durationMs !== undefined) this.project.durationMs = durationMs;
  }
}

class MemoryMultipart implements R2MultipartUploadLike {
  uploaded: R2UploadedPartLike[] = [];
  constructor(public readonly key: string, public readonly uploadId: string) {}
  async uploadPart(partNumber: number, _value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob) {
    const part = { partNumber, etag: `etag-${partNumber}` };
    this.uploaded.push(part);
    return part;
  }
  async complete(parts: R2UploadedPartLike[]) { return { key: this.key, size: parts.length * 1024 }; }
  async abort() {}
}

async function valueSize(value: R2UploadValue): Promise<number> {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  return (await new Response(value).arrayBuffer()).byteLength;
}

class MemoryBucket implements R2BucketLike {
  multipart?: MemoryMultipart;
  objects = new Map<string, { size: number; value: R2UploadValue }>();
  async createMultipartUpload(key: string) {
    this.multipart = new MemoryMultipart(key, 'upload-1');
    return this.multipart;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    if (!this.multipart || this.multipart.key !== key || this.multipart.uploadId !== uploadId) throw new Error('missing upload');
    return this.multipart;
  }
  async put(key: string, value: R2UploadValue) {
    const size = await valueSize(value);
    this.objects.set(key, { size, value });
    return { key, size };
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { key, size: object.size } : null;
  }
}

function pcmWav(durationMs = 1000): ArrayBuffer {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataBytes = Math.round(sampleRate * channels * (bitsPerSample / 8) * durationMs / 1000);
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  view.setUint16(32, channels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buffer;
}

describe('R2 multipart upload service', () => {
  it('accepts supported formats and rejects media over 5 GB', () => {
    expect(normalizeUploadInput({ filename: 'movie.MP4', sizeBytes: 1024, contentType: 'video/mp4' }).extension).toBe('mp4');
    expect(() => normalizeUploadInput({ filename: 'movie.mp4', sizeBytes: 5 * 1024 ** 3 + 1, contentType: 'video/mp4' })).toThrow(UploadInputError);
  });

  it('validates ownership and media before creating any multipart upload', async () => {
    const store = new MemoryProjectStore();
    const bucket = new MemoryBucket();
    const service = new UploadService(bucket, store, () => 'asset-1');

    const validated = await service.validateBegin('project-1', 'dev-user', {
      filename: 'movie.mp4', sizeBytes: 1000, contentType: 'video/mp4',
    });
    expect(bucket.multipart).toBeUndefined();
    expect(validated.extension).toBe('mp4');

    const begun = await service.beginValidated('project-1', validated);
    expect(bucket.multipart?.key).toBe('projects/project-1/source/asset-1.mp4');
    expect(begun.objectKey).toBe('projects/project-1/source/asset-1.mp4');
  });

  it('confines keys to the project, uploads a stream part, and persists completed object size', async () => {
    const store = new MemoryProjectStore();
    const bucket = new MemoryBucket();
    const service = new UploadService(bucket, store, () => 'asset-1');
    const begun = await service.begin('project-1', 'dev-user', { filename: 'movie.mp4', sizeBytes: 1000, contentType: 'video/mp4' });
    expect(begun.objectKey).toBe('projects/project-1/source/asset-1.mp4');
    expect(begun.partSizeBytes).toBe(25 * 1024 * 1024);

    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    const part = await service.uploadPart('project-1', 'dev-user', begun.uploadId, begun.objectKey, 1, body);
    expect(part).toEqual({ partNumber: 1, etag: 'etag-1' });

    const completed = await service.complete('project-1', 'dev-user', begun.uploadId, begun.objectKey, [part]);
    expect(completed).toEqual({ objectKey: begun.objectKey, size: 1024 });
    expect(store.saved).toEqual({ key: begun.objectKey, size: 1024 });
  });

  it('rejects a key outside the owned project and invalid part numbers', async () => {
    const service = new UploadService(new MemoryBucket(), new MemoryProjectStore(), () => 'asset-1');
    await expect(service.uploadPart('project-1', 'dev-user', 'upload-1', 'projects/other/source/x.mp4', 1, new ReadableStream())).rejects.toMatchObject({ code: 'UPLOAD_KEY_INVALID' });
    await expect(service.uploadPart('project-1', 'dev-user', 'upload-1', 'projects/project-1/source/x.mp4', 0, new ReadableStream())).rejects.toMatchObject({ code: 'UPLOAD_PART_INVALID' });
  });
});

describe('prepared long-form ASR uploads', () => {
  it('stores a canonical current-generation PCM WAV chunk under a server-derived key', async () => {
    const store = new MemoryProjectStore();
    store.project.sourceObjectKey = 'projects/project-1/source/source.mp4';
    store.project.sourceGeneration = 2;
    const bucket = new MemoryBucket();
    const service = new UploadService(bucket, store);

    const descriptor = await service.uploadPreparedAsrChunk('project-1', 'dev-user', {
      sourceGeneration: 2,
      index: 0,
      offsetMs: 0,
      durationMs: 1000,
      wav: pcmWav(1000),
    });

    expect(descriptor.objectKey).toBe('projects/project-1/asr/source-2/chunk-0.wav');
    expect(descriptor.sizeBytes).toBe(32_044);
    expect(bucket.objects.has(descriptor.objectKey)).toBe(true);
  });

  it('fails stale generations and malformed WAV input before writing R2', async () => {
    const store = new MemoryProjectStore();
    store.project.sourceObjectKey = 'projects/project-1/source/source.mp4';
    store.project.sourceGeneration = 3;
    const bucket = new MemoryBucket();
    const service = new UploadService(bucket, store);

    await expect(service.uploadPreparedAsrChunk('project-1', 'dev-user', {
      sourceGeneration: 2, index: 0, offsetMs: 0, durationMs: 1000, wav: pcmWav(1000),
    })).rejects.toMatchObject({ code: 'ASR_PREP_STALE' });
    await expect(service.uploadPreparedAsrChunk('project-1', 'dev-user', {
      sourceGeneration: 3, index: 0, offsetMs: 0, durationMs: 1000, wav: new ArrayBuffer(64),
    })).rejects.toMatchObject({ code: 'ASR_PREP_WAV_INVALID' });
    expect(bucket.objects.size).toBe(0);
  });

  it('commits only contiguous canonical descriptors whose objects exist at exact sizes', async () => {
    const store = new MemoryProjectStore();
    store.project.sourceObjectKey = 'projects/project-1/source/source.mp4';
    store.project.sourceGeneration = 4;
    const bucket = new MemoryBucket();
    const service = new UploadService(bucket, store);

    const first = await service.uploadPreparedAsrChunk('project-1', 'dev-user', {
      sourceGeneration: 4, index: 0, offsetMs: 0, durationMs: 1000, wav: pcmWav(1000),
    });
    const second = await service.uploadPreparedAsrChunk('project-1', 'dev-user', {
      sourceGeneration: 4, index: 1, offsetMs: 1000, durationMs: 1000, wav: pcmWav(1000),
    });

    const completed = await service.completePreparedAsr('project-1', 'dev-user', {
      sourceGeneration: 4,
      durationMs: 2000,
      chunks: [first, second],
    });
    expect(completed.manifestKey).toBe('projects/project-1/asr/source-4/manifest.json');
    expect(completed.chunkCount).toBe(2);
    expect(bucket.objects.has(completed.manifestKey)).toBe(true);

    await expect(service.completePreparedAsr('project-1', 'dev-user', {
      sourceGeneration: 4,
      durationMs: 2000,
      chunks: [first, { ...second, objectKey: 'projects/other/asr/source-4/chunk-1.wav' }],
    })).rejects.toMatchObject({ code: 'ASR_PREP_DESCRIPTOR_INVALID' });
  });
});
