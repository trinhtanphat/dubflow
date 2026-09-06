import { describe, expect, it } from 'vitest';
import type { R2BucketLike, R2MultipartUploadLike, R2UploadedPartLike } from '../src/cloudflare/r2';
import type { Project, ProjectStatus, ProjectStore } from '../src/db/projects';
import { normalizeUploadInput, UploadInputError } from '../src/domain/upload';
import { UploadService } from '../src/services/uploads';

class MemoryProjectStore implements ProjectStore {
  project: Project = {
    id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh', targetLanguage: 'vi', targetLanguagesRevision: 1, sourceRevision: 1, status: 'draft',
  };
  saved?: { key: string; size: number };
  async create(): Promise<Project> { return this.project; }
  async listByUser(): Promise<Project[]> { return [this.project]; }
  async getByIdForUser(id: string, userId: string): Promise<Project | null> {
    return id === this.project.id && userId === this.project.userId ? this.project : null;
  }
  async setSourceObject(_id: string, _userId: string, objectKey: string, sizeBytes: number) {
    this.saved = { key: objectKey, size: sizeBytes };
    if (this.project.sourceObjectKey && this.project.sourceObjectKey !== objectKey) this.project.sourceRevision += 1;
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

class MemoryBucket implements R2BucketLike {
  multipart?: MemoryMultipart;
  async createMultipartUpload(key: string) {
    this.multipart = new MemoryMultipart(key, 'upload-1');
    return this.multipart;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    if (!this.multipart || this.multipart.key !== key || this.multipart.uploadId !== uploadId) throw new Error('missing upload');
    return this.multipart;
  }
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