import type { StreamTargetChunk } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { createR2MultipartWritable } from '../src/services/media/r2-multipart-target';

function streamChunk(position: number, size: number): StreamTargetChunk {
  return { type: 'write', position, data: new Uint8Array(size) };
}

describe('R2 multipart output', () => {
  it('uploads sequential bounded StreamTarget chunks and preserves backpressure', async () => {
    const uploaded: Array<{ partNumber: number; size: number }> = [];
    let completed: Array<{ partNumber: number; etag: string }> = [];
    let aborted = false;
    const bucket = {
      async createMultipartUpload(key: string) {
        return {
          key,
          uploadId: 'upload-1',
          async uploadPart(partNumber: number, value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream) {
            const size = ArrayBuffer.isView(value)
              ? value.byteLength
              : value instanceof ArrayBuffer
                ? value.byteLength
                : 0;
            uploaded.push({ partNumber, size });
            return { partNumber, etag: `etag-${partNumber}` };
          },
          async complete(parts: Array<{ partNumber: number; etag: string }>) {
            completed = parts;
            return { key, size: uploaded.reduce((sum, item) => sum + item.size, 0) };
          },
          async abort() { aborted = true; },
        };
      },
    };

    const target = await createR2MultipartWritable(bucket as never, 'exports/out.mp4', {
      partSize: 8 * 1024 * 1024,
    });
    const writer = target.writable.getWriter();
    await writer.write(streamChunk(0, 5 * 1024 * 1024));
    await writer.write(streamChunk(5 * 1024 * 1024, 12 * 1024 * 1024));
    await writer.write(streamChunk(17 * 1024 * 1024, 3 * 1024 * 1024));
    await writer.close();
    await target.complete();

    expect(uploaded).toEqual([
      { partNumber: 1, size: 8 * 1024 * 1024 },
      { partNumber: 2, size: 8 * 1024 * 1024 },
      { partNumber: 3, size: 4 * 1024 * 1024 },
    ]);
    expect(completed.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(target.stats.maxBufferedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(aborted).toBe(false);
  });

  it('rejects non-append-only StreamTarget writes before corrupting the multipart object', async () => {
    let aborted = false;
    const bucket = {
      async createMultipartUpload(key: string) {
        return {
          key,
          uploadId: 'upload-1',
          async uploadPart(partNumber: number) { return { partNumber, etag: `etag-${partNumber}` }; },
          async complete() { return { key, size: 0 }; },
          async abort() { aborted = true; },
        };
      },
    };

    const target = await createR2MultipartWritable(bucket as never, 'exports/out.mp4', { partSize: 8 * 1024 * 1024 });
    const writer = target.writable.getWriter();
    await writer.write(streamChunk(0, 1024));
    await expect(writer.write(streamChunk(512, 1024))).rejects.toThrow(/MP4_REMUX_FAILED/);
    expect(aborted).toBe(true);
  });

  it('aborts and reports a stable R2 error when an upload part fails', async () => {
    let aborted = false;
    const bucket = {
      async createMultipartUpload(key: string) {
        return {
          key,
          uploadId: 'upload-1',
          async uploadPart() { throw new Error('boom'); },
          async complete() { return { key, size: 0 }; },
          async abort() { aborted = true; },
        };
      },
    };
    const target = await createR2MultipartWritable(bucket as never, 'exports/out.mp4', {
      partSize: 8 * 1024 * 1024,
    });
    const writer = target.writable.getWriter();
    await expect(writer.write(streamChunk(0, 8 * 1024 * 1024))).rejects.toThrow(/R2_EXPORT_WRITE_FAILED/);
    expect(aborted).toBe(true);
  });
});
