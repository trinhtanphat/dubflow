import { describe, expect, it } from 'vitest';
import type { R2ReadableBucketLike } from '../src/cloudflare/r2';
import { streamMediaObject } from '../src/http/media-stream';

function bytes(values: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from(values));
      controller.close();
    },
  });
}

describe('shared R2 media streaming', () => {
  it('streams a full object without a metadata head request', async () => {
    let headCalls = 0;
    const bucket: R2ReadableBucketLike = {
      async head() {
        headCalls += 1;
        return { key: 'projects/p1/export/final.mp4', size: 4 };
      },
      async get(key, options) {
        expect(key).toBe('projects/p1/export/final.mp4');
        expect(options).toBeUndefined();
        return {
          key,
          size: 4,
          body: bytes([10, 20, 30, 40]),
          httpMetadata: { contentType: 'video/mp4' },
          httpEtag: 'etag-full',
        };
      },
    };

    const response = await streamMediaObject(
      bucket,
      'projects/p1/export/final.mp4',
      new Request('https://example.test/media'),
      'p1-dubbed.mp4',
    );

    expect(response.status).toBe(200);
    expect(headCalls).toBe(0);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('etag')).toBe('etag-full');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="p1-dubbed.mp4"');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([10, 20, 30, 40]);
  });

  it('streams only the requested byte range with exact range headers', async () => {
    const getOptions: unknown[] = [];
    const bucket: R2ReadableBucketLike = {
      async head(key) {
        expect(key).toBe('projects/p1/export/final.mp4');
        return { key, size: 100, httpMetadata: { contentType: 'video/mp4' }, httpEtag: 'etag-range' };
      },
      async get(key, options) {
        getOptions.push(options);
        return {
          key,
          size: 10,
          body: bytes([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
          httpMetadata: { contentType: 'video/mp4' },
          httpEtag: 'etag-range',
        };
      },
    };

    const response = await streamMediaObject(
      bucket,
      'projects/p1/export/final.mp4',
      new Request('https://example.test/media', { headers: { Range: 'bytes=10-19' } }),
      'p1-dubbed.mp4',
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(response.headers.get('content-length')).toBe('10');
    expect(getOptions).toEqual([{ range: { offset: 10, length: 10 } }]);
  });

  it('returns 416 for an unsatisfiable range without reading the body', async () => {
    let bodyRead = false;
    const bucket: R2ReadableBucketLike = {
      async head(key) {
        return { key, size: 100 };
      },
      async get() {
        bodyRead = true;
        return null;
      },
    };

    const response = await streamMediaObject(
      bucket,
      'projects/p1/export/final.mp4',
      new Request('https://example.test/media', { headers: { Range: 'bytes=120-130' } }),
      'p1-dubbed.mp4',
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes */100');
    expect(bodyRead).toBe(false);
  });

  it('sanitizes an unsafe download filename deterministically', async () => {
    const bucket: R2ReadableBucketLike = {
      async get(key) {
        return { key, size: 1, body: bytes([1]), httpMetadata: { contentType: 'video/mp4' } };
      },
    };
    const unsafe = '../bad"name\r\nclip.mp4';

    const first = await streamMediaObject(
      bucket,
      'projects/p1/export/final.mp4',
      new Request('https://example.test/media'),
      unsafe,
    );
    const second = await streamMediaObject(
      bucket,
      'projects/p1/export/final.mp4',
      new Request('https://example.test/media'),
      unsafe,
    );

    const disposition = first.headers.get('content-disposition');
    expect(disposition).toBe(second.headers.get('content-disposition'));
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    expect(disposition).not.toContain('../');
  });
});
