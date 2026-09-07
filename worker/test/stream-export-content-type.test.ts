import { describe, expect, it, vi } from 'vitest';
import { StreamMediaService } from '../src/services/media/stream';

describe('StreamMediaService canonical export validation', () => {
  it('rejects a successful HTTP download whose body is not video before writing the canonical MP4 to R2', async () => {
    const sourceObjectKey = 'projects/p1/source/a.mp4';
    const bucketPut = vi.fn(async () => ({ key: 'out', size: 9 }));
    const service = new StreamMediaService({
      projects: {
        async getByIdForUser() {
          return {
            id: 'p1',
            sourceObjectKey,
            streamVideoUid: 'shared-source',
            streamSourceObjectKey: sourceObjectKey,
            streamReadyAt: '2026-09-07T00:00:00Z',
          };
        },
        async setStreamProvenance() {},
      } as never,
      exportAssets: {
        async get() {
          return { streamVideoUid: 'render-existing', streamSourceObjectKey: sourceObjectKey };
        },
        async setStreamProvenance() {
          throw new Error('retry path must reuse durable render provenance');
        },
      } as never,
      stream: {
        async upload() {
          throw new Error('retry path must not upload another render asset');
        },
        video(id: string) {
          expect(id).toBe('render-existing');
          return {
            async details() {
              return { id, readyToStream: true, duration: 12.5, status: { state: 'ready' } };
            },
            downloads: {
              async generate(type?: string) { expect(type).toBe('default'); },
              async get() {
                return { default: { status: 'ready', url: 'https://videodelivery.net/not-video.mp4' } };
              },
            },
          };
        },
      } as never,
      bucket: { put: bucketPut } as never,
      publicOrigin: 'https://yupvox.qs3d.site',
      signingSecret: 'secret',
      accountId: 'account-1',
      apiToken: 'stream-token',
      fetcher: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.endsWith('/audio')) {
          return Response.json({
            success: true,
            result: {
              audio: [{ uid: 'audio-existing', label: 'dubflow-vi-e1', default: true, status: 'ready' }],
            },
          });
        }
        if (method === 'PATCH' && url.endsWith('/audio/audio-existing')) {
          return Response.json({
            success: true,
            result: { uid: 'audio-existing', label: 'dubflow-vi-e1', default: true, status: 'ready' },
          });
        }
        if (method === 'GET' && url === 'https://videodelivery.net/not-video.mp4') {
          return new Response('<html>upstream error</html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      },
      wait: async () => {},
    });

    await expect(service.publishDubbedExport({
      projectId: 'p1',
      userId: 'dev-user',
      sourceObjectKey,
      soundtrackObjectKey: 'projects/p1/soundtracks/vi/e1.wav',
      targetLanguage: 'vi',
      exportId: 'e1',
      exportObjectKey: 'projects/p1/exports/vi/e1.mp4',
    })).rejects.toThrow('STREAM_DOWNLOAD_FAILED: Stream MP4 download returned non-video content.');
    expect(bucketPut).not.toHaveBeenCalled();
  });
});
