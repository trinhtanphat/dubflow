import { describe, expect, it } from 'vitest';
import app from '../src/app';

async function signature(secret: string, projectId: string, key: string, expires: number) {
  const signingKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign(
    'HMAC',
    signingKey,
    new TextEncoder().encode(`${projectId}\n${key}\n${expires}`),
  );
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

describe('signed Stream source route', () => {
  it('serves HEAD and byte ranges from the private R2 source after signature validation', async () => {
    const projectId = 'p1';
    const key = 'projects/p1/source/video.mp4';
    const secret = 'stream-source-secret';
    const expires = Math.floor(Date.now() / 1000) + 300;
    const sig = await signature(secret, projectId, key, expires);
    const url = `https://dubflow.test/api/stream-source/${projectId}?key=${encodeURIComponent(key)}&expires=${expires}&signature=${sig}`;
    const env = {
      STREAM_SOURCE_SIGNING_SECRET: secret,
      MEDIA: {
        async head(requested: string) {
          if (requested !== key) return null;
          return { key, size: 10, httpEtag: 'etag', httpMetadata: { contentType: 'video/mp4' } };
        },
        async get(requested: string, options?: { range?: { offset: number; length: number } }) {
          if (requested !== key) return null;
          const range = options?.range ?? { offset: 0, length: 10 };
          return {
            key,
            size: 10,
            range,
            httpEtag: 'etag',
            httpMetadata: { contentType: 'video/mp4' },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(range.length).fill(7));
                controller.close();
              },
            }),
          };
        },
      },
      ASSETS: { fetch: async () => new Response('asset fallback') },
    } as never;

    const head = await app.fetch(new Request(url, { method: 'HEAD' }), env);
    expect(head.status).toBe(200);
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('content-length')).toBe('10');
    expect(head.headers.get('content-type')).toBe('video/mp4');

    const ranged = await app.fetch(new Request(url, { headers: { range: 'bytes=2-5' } }), env);
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(new Uint8Array(await ranged.arrayBuffer())).toHaveLength(4);
  });

  it('rejects an expired source token before reading R2', async () => {
    const key = 'projects/p1/source/video.mp4';
    const secret = 'stream-source-secret';
    const expires = Math.floor(Date.now() / 1000) - 1;
    const sig = await signature(secret, 'p1', key, expires);
    let touched = false;
    const response = await app.fetch(
      new Request(`https://dubflow.test/api/stream-source/p1?key=${encodeURIComponent(key)}&expires=${expires}&signature=${sig}`),
      {
        STREAM_SOURCE_SIGNING_SECRET: secret,
        MEDIA: { async get() { touched = true; return null; }, async head() { touched = true; return null; } },
        ASSETS: { fetch: async () => new Response('asset fallback') },
      } as never,
    );
    expect(response.status).toBe(403);
    expect(touched).toBe(false);
  });
});
