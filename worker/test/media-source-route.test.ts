import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createMediaSourceRoutes } from '../src/routes/media-source';
import { createMediaSourceToken } from '../src/security/media-source-token';

function projectFixture(sourceObjectKey = 'projects/project-1/source/movie.mp4') {
  return {
    id: 'project-1', userId: 'dev-user', title: 'Movie', sourceLanguage: 'en' as const,
    targetLanguage: 'vi' as const, targetLanguagesRevision: 1, status: 'ready' as const,
    sourceObjectKey,
  };
}

function bytesBody(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function makeRequest(options: {
  currentSource?: string;
  requestKey?: string;
  method?: string;
  range?: string;
  badSignature?: boolean;
  missingObject?: boolean;
}) {
  const projectId = 'project-1';
  const key = options.requestKey ?? 'projects/project-1/source/movie.mp4';
  const secret = 'media-secret';
  const expires = Math.floor(Date.now() / 1000) + 300;
  const signature = options.badSignature
    ? '0'.repeat(64)
    : await createMediaSourceToken(secret, projectId, key, expires);
  const all = Uint8Array.from({ length: 10 }, (_, index) => index);
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/media-source', createMediaSourceRoutes({
    makeProjects: () => ({
      async getByIdForUser() { return projectFixture(options.currentSource); },
    }) as never,
  }));
  const env = {
    MEDIA_SOURCE_SIGNING_SECRET: secret,
    MEDIA: {
      async head(requested: string) {
        if (options.missingObject || requested !== key) return null;
        return { key, size: all.byteLength, httpEtag: 'etag-1', httpMetadata: { contentType: 'video/mp4' } };
      },
      async get(requested: string, input?: { range?: { offset: number; length: number } }) {
        if (options.missingObject || requested !== key) return null;
        const range = input?.range ?? { offset: 0, length: all.byteLength };
        return {
          key,
          size: all.byteLength,
          range,
          httpEtag: 'etag-1',
          httpMetadata: { contentType: 'video/mp4' },
          body: bytesBody(all.slice(range.offset, range.offset + range.length)),
        };
      },
    },
  } as unknown as Env;
  const url = `https://dubflow.test/api/media-source/${projectId}?key=${encodeURIComponent(key)}&expires=${expires}&signature=${signature}`;
  const headers = options.range ? { Range: options.range } : undefined;
  return app.request(url, { method: options.method ?? 'GET', headers }, env);
}

describe('signed R2 media source route', () => {
  it('serves HEAD and exact byte ranges for the current source only', async () => {
    const head = await makeRequest({ method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('content-length')).toBe('10');
    expect(head.headers.get('content-type')).toBe('video/mp4');
    expect(head.headers.get('etag')).toBe('etag-1');

    const ranged = await makeRequest({ range: 'bytes=2-5' });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(Uint8Array.from([2, 3, 4, 5]));
  });

  it('fails closed for bad token, missing object, or a changed project source', async () => {
    expect((await makeRequest({ badSignature: true })).status).toBe(403);
    expect((await makeRequest({ missingObject: true })).status).toBe(404);
    expect((await makeRequest({ currentSource: 'projects/project-1/source/replaced.mp4' })).status).toBe(409);
  });
});
