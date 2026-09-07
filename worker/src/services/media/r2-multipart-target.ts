import type { StreamTargetChunk } from 'mediabunny';

type MultipartPart = {
  partNumber: number;
  etag: string;
};

type MultipartUploadLike = {
  uploadPart(
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream,
  ): Promise<MultipartPart>;
  complete(parts: MultipartPart[]): Promise<unknown>;
  abort(): Promise<void>;
};

type R2BucketLike = {
  createMultipartUpload(key: string): Promise<MultipartUploadLike>;
};

type MultipartOptions = {
  partSize?: number;
};

const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

export async function createR2MultipartWritable(
  bucket: R2BucketLike,
  key: string,
  options: MultipartOptions = {},
) {
  const partSize = options.partSize ?? DEFAULT_PART_SIZE;
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new Error('R2_EXPORT_PART_SIZE_INVALID');
  }

  const upload = await bucket.createMultipartUpload(key);
  const uploadedParts: MultipartPart[] = [];
  const stats = { maxBufferedBytes: 0 };

  let buffer = new Uint8Array(partSize);
  let bufferedBytes = 0;
  let partNumber = 1;
  let expectedPosition = 0;
  let failed = false;
  let closed = false;
  let completed = false;

  const abortUpload = async () => {
    if (failed) return;
    failed = true;
    try {
      await upload.abort();
    } catch {
      // Preserve the primary stable error when cleanup also fails.
    }
  };

  const abortWithStableError = async (cause?: unknown): Promise<never> => {
    await abortUpload();
    const error = new Error('R2_EXPORT_WRITE_FAILED');
    if (cause !== undefined) {
      (error as Error & { cause?: unknown }).cause = cause;
    }
    throw error;
  };

  const abortWithRemuxError = async (message: string): Promise<never> => {
    await abortUpload();
    throw new Error(`MP4_REMUX_FAILED: ${message}`);
  };

  const uploadBufferedPart = async () => {
    if (bufferedBytes === 0) return;

    const bytes = bufferedBytes === partSize
      ? buffer
      : buffer.slice(0, bufferedBytes);

    try {
      const part = await upload.uploadPart(partNumber, bytes);
      uploadedParts.push({ partNumber: part.partNumber, etag: part.etag });
      partNumber += 1;
      buffer = new Uint8Array(partSize);
      bufferedBytes = 0;
    } catch (error) {
      await abortWithStableError(error);
    }
  };

  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      if (failed || closed) {
        throw new Error('R2_EXPORT_WRITE_FAILED');
      }
      if (chunk.type !== 'write' || chunk.position !== expectedPosition) {
        await abortWithRemuxError(
          `multipart target requires append-only writes at ${expectedPosition}, got ${chunk.position}`,
        );
      }

      const data = chunk.data;
      expectedPosition += data.byteLength;
      let offset = 0;
      while (offset < data.byteLength) {
        const writableBytes = Math.min(partSize - bufferedBytes, data.byteLength - offset);
        buffer.set(data.subarray(offset, offset + writableBytes), bufferedBytes);
        bufferedBytes += writableBytes;
        offset += writableBytes;
        stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, bufferedBytes);

        if (bufferedBytes === partSize) {
          await uploadBufferedPart();
        }
      }
    },
    async close() {
      if (failed) throw new Error('R2_EXPORT_WRITE_FAILED');
      await uploadBufferedPart();
      closed = true;
    },
    async abort() {
      await abortUpload();
    },
  });

  return {
    writable,
    stats,
    async complete() {
      if (failed) throw new Error('R2_EXPORT_WRITE_FAILED');
      if (!closed) throw new Error('R2_EXPORT_NOT_CLOSED');
      if (completed) return;

      try {
        await upload.complete(uploadedParts);
        completed = true;
      } catch (error) {
        await abortWithStableError(error);
      }
    },
  };
}
