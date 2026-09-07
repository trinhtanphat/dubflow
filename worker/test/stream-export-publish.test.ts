import { describe, expect, it } from 'vitest';
import { StreamMediaService } from '../src/services/media/stream';

function readyVideo(uid = 'stream-existing') {
  return {
    id: uid,
    readyToStream: true,
    readyToStreamAt: '2026-09-07T00:00:00Z',
    duration: 12.5,
    status: { state: 'ready' },
  };
}

describe('StreamMediaService dubbed export publication', () => {
  it('copies a signed R2 soundtrack, selects it, generates MP4, and streams the exact export key back to R2', async () => {
    const apiCalls: Array<{ method: string; url: string; body?: unknown }> = [];
    const downloadGenerate: string[] = [];
    const puts: Array<{ key: string; bytes: string; contentType?: string }> = [];
    let audioPoll = 0;
    let downloadPoll = 0;

    const project = {
      id: 'p1',
      sourceObjectKey: 'projects/p1/source/a.mp4',
      streamVideoUid: 'stream-existing',
      streamSourceObjectKey: 'projects/p1/source/a.mp4',
      streamReadyAt: '2026-09-07T00:00:00Z',
    };
    const projects = {
      async getByIdForUser() { return project; },
      async setStreamProvenance() { throw new Error('must reuse matching Stream provenance'); },
    };
    const stream = {
      async upload() { throw new Error('must not re-upload matching source'); },
      video(id: string) {
        expect(id).toBe('stream-existing');
        return {
          async details() { return readyVideo(); },
          downloads: {
            async generate(type?: string) { downloadGenerate.push(type ?? 'default'); },
            async get() {
              downloadPoll += 1;
              return downloadPoll < 2
                ? { default: { status: 'queued', percentComplete: 20 } }
                : { default: { status: 'ready', percentComplete: 100, url: 'https://videodelivery.net/final.mp4' } };
            },
          },
        };
      },
    };
    const bucket = {
      async put(key: string, value: ReadableStream<Uint8Array>, options?: { httpMetadata?: { contentType?: string } }) {
        puts.push({
          key,
          bytes: await new Response(value).text(),
          contentType: options?.httpMetadata?.contentType,
        });
        return { key, size: 8 };
      },
    };
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const rawBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      apiCalls.push({ method, url, body: rawBody });
      expect(new Headers(init?.headers).get('authorization')).toBe(
        url.startsWith('https://api.cloudflare.com/') ? 'Bearer stream-token' : null,
      );

      if (method === 'POST' && url.endsWith('/audio/copy')) {
        return Response.json({ success: true, result: { uid: 'audio-1', label: 'dubflow-vi-e1', default: false, status: 'queued' } });
      }
      if (method === 'GET' && url.endsWith('/audio')) {
        audioPoll += 1;
        return Response.json({
          success: true,
          result: {
            audio: [{ uid: 'audio-1', label: 'dubflow-vi-e1', default: false, status: audioPoll < 2 ? 'queued' : 'ready' }],
          },
        });
      }
      if (method === 'PATCH' && url.endsWith('/audio/audio-1')) {
        expect(rawBody).toEqual({ default: true });
        return Response.json({ success: true, result: { uid: 'audio-1', label: 'dubflow-vi-e1', default: true, status: 'ready' } });
      }
      if (method === 'GET' && url === 'https://videodelivery.net/final.mp4') {
        return new Response('mp4-data', { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    };

    const service = new StreamMediaService({
      projects: projects as never,
      stream: stream as never,
      bucket: bucket as never,
      publicOrigin: 'https://yupvox.qs3d.site',
      signingSecret: 'secret',
      accountId: 'account-1',
      apiToken: 'stream-token',
      fetcher,
      nowSeconds: () => 1_800_000_000,
      wait: async () => {},
    });

    await expect(service.publishDubbedExport({
      projectId: 'p1',
      userId: 'dev-user',
      sourceObjectKey: project.sourceObjectKey,
      soundtrackObjectKey: 'projects/p1/soundtracks/vi/e1.wav',
      targetLanguage: 'vi',
      exportId: 'e1',
      exportObjectKey: 'projects/p1/exports/vi/e1.mp4',
    })).resolves.toEqual({ exportObjectKey: 'projects/p1/exports/vi/e1.mp4', audioTrackUid: 'audio-1' });

    const copy = apiCalls.find((call) => call.method === 'POST');
    expect(copy?.url).toBe('https://api.cloudflare.com/client/v4/accounts/account-1/stream/stream-existing/audio/copy');
    expect(copy?.body).toMatchObject({ label: 'dubflow-vi-e1' });
    const soundtrackUrl = new URL((copy?.body as { url: string }).url);
    expect(soundtrackUrl.origin + soundtrackUrl.pathname).toBe('https://yupvox.qs3d.site/api/stream-source/p1');
    expect(soundtrackUrl.searchParams.get('key')).toBe('projects/p1/soundtracks/vi/e1.wav');
    expect(soundtrackUrl.searchParams.get('signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(downloadGenerate).toEqual(['default']);
    expect(puts).toEqual([{ key: 'projects/p1/exports/vi/e1.mp4', bytes: 'mp4-data', contentType: 'video/mp4' }]);
  });
});
