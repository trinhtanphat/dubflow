import { CustomSource } from 'mediabunny';

type R2HeadLike = {
  size: number;
};

type R2GetLike = {
  body?: ReadableStream<Uint8Array> | null;
};

type R2BucketLike = {
  head(key: string): Promise<R2HeadLike | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<R2GetLike | null>;
};

export type R2RangeReader = {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
};

async function readAll(stream: ReadableStream<Uint8Array>, expectedLength: number) {
  const reader = stream.getReader();
  const result = new Uint8Array(expectedLength);
  let offset = 0;

  try {
    while (offset < expectedLength) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = expectedLength - offset;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (offset !== expectedLength) {
    throw new Error('R2_SOURCE_READ_FAILED');
  }

  return result;
}

export async function createR2RangeReader(
  bucket: R2BucketLike,
  key: string,
): Promise<R2RangeReader> {
  const object = await bucket.head(key);
  if (!object || !Number.isFinite(object.size) || object.size < 0) {
    throw new Error('R2_SOURCE_NOT_FOUND');
  }

  const size = object.size;

  return {
    size,
    async read(start: number, end: number) {
      if (
        !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || start < 0
        || end <= start
        || end > size
      ) {
        throw new Error('R2_SOURCE_RANGE_INVALID');
      }

      const length = end - start;
      const ranged = await bucket.get(key, {
        range: { offset: start, length },
      });
      if (!ranged?.body) {
        throw new Error('R2_SOURCE_READ_FAILED');
      }

      return readAll(ranged.body, length);
    },
  };
}

export async function createR2MediaSource(bucket: R2BucketLike, key: string) {
  const reader = await createR2RangeReader(bucket, key);

  return new CustomSource({
    getSize: () => reader.size,
    read: (start, end) => reader.read(start, end),
    maxCacheSize: 8 * 1024 * 1024,
    prefetchProfile: 'network',
  });
}
