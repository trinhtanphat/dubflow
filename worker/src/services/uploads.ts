import type { R2BucketLike, R2UploadedPartLike, R2UploadValue } from '../cloudflare/r2';
import type { ProjectStore } from '../db/projects';
import { normalizeUploadInput, type BeginUploadInput, UploadInputError } from '../domain/upload';

export const MULTIPART_PART_SIZE_BYTES = 25 * 1024 * 1024;

export class UploadServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UploadServiceError';
  }
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

  async begin(projectId: string, userId: string, rawInput: BeginUploadInput) {
    await this.requireProject(projectId, userId);
    let input;
    try {
      input = normalizeUploadInput(rawInput);
    } catch (error) {
      if (error instanceof UploadInputError) throw error;
      throw new UploadServiceError('UPLOAD_MEDIA_INVALID', 'Invalid media input.');
    }

    const objectKey = `projects/${projectId}/source/${this.createId()}.${input.extension}`;
    const multipart = await this.bucket.createMultipartUpload(objectKey);
    return {
      uploadId: multipart.uploadId,
      objectKey,
      partSizeBytes: MULTIPART_PART_SIZE_BYTES,
    };
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
}
