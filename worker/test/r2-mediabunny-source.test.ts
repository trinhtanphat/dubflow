import { describe, expect, it } from 'vitest';
import { createR2MediaSource, createR2RangeReader } from '../src/services/media/r2-mediabunny-source';

describe('R2 Mediabunny source', () => {
  it('reads exact byte ranges instead of buffering the whole R2 object', async () => {
    const calls: Array<{ offset: number; length: number }> = [];
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    const bucket = {
      async head() { return { key: 'source.mp4', size: bytes.length }; },
      async get(_key: string, options?: { range?: { offset: number; length: number } }) {
        const range = options?.range ?? { offset: 0, length: bytes.length };
        calls.push(range);
        return {
          key: 'source.mp4', size: bytes.length, range,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(range.offset, range.offset + range.length));
              controller.close();
            },
          }),
        };
      },
    };

    const reader = await createR2RangeReader(bucket as never, 'source.mp4');
    expect(reader.size).toBe(64);
    expect(await reader.read(10, 20)).toEqual(bytes.slice(10, 20));
    expect(calls).toEqual([{ offset: 10, length: 10 }]);

    const source = await createR2MediaSource(bucket as never, 'source.mp4');
    expect(await source.getSize()).toBe(64);
  });
});
