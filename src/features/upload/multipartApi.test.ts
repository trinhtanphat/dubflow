import { describe, expect, it } from 'vitest';
import { uploadMediaMultipart } from './multipartApi';

describe('multipart media client', () => {
  it('uploads only bounded parts and completes with returned ETags', async () => {
    const file = Object.assign(new Blob([new Uint8Array(11)]), { name: 'movie.mp4' });
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith('/uploads')) return Response.json({ uploadId: 'u1', objectKey: 'projects/p/source/a.mp4', partSizeBytes: 5 }, { status: 201 });
      if (url.includes('/parts/')) {
        const n = Number(url.match(/parts\/(\d+)/)?.[1]);
        return Response.json({ partNumber: n, etag: `e${n}` });
      }
      return Response.json({ objectKey: 'projects/p/source/a.mp4', size: 11 });
    };
    const progress: number[] = [];
    const result = await uploadMediaMultipart('p', file as File, fakeFetch, (value) => progress.push(value));
    expect(result).toEqual({ objectKey: 'projects/p/source/a.mp4', size: 11 });
    expect(calls.filter((call) => call.url.includes('/parts/')).length).toBe(3);
    expect(progress.at(-1)).toBe(1);
    const completeBody = JSON.parse(String(calls.at(-1)?.init?.body));
    expect(completeBody.parts).toEqual([{ partNumber: 1, etag: 'e1' }, { partNumber: 2, etag: 'e2' }, { partNumber: 3, etag: 'e3' }]);
  });
});
