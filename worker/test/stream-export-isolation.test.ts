import { describe, expect, it } from 'vitest';
import { StreamMediaService } from '../src/services/media/stream';

type RenderState = { streamVideoUid: string | null; streamSourceObjectKey: string | null };

describe('StreamMediaService export render isolation', () => {
  it('uses one private Stream render asset per export so parallel language exports cannot race on default audio', async () => {
    const sourceObjectKey = 'projects/p1/source/a.mp4';
    const project = {
      id: 'p1',
      sourceObjectKey,
      streamVideoUid: 'shared-source',
      streamSourceObjectKey: sourceObjectKey,
      streamReadyAt: '2026-09-07T00:00:00Z',
    };
    const renderState = new Map<string, RenderState>();
    const uploadExportIds: string[] = [];
    const apiUrls: string[] = [];
    const copied = new Set<string>();

    const exportAssets = {
      async get(projectId: string, exportId: string) {
        expect(projectId).toBe('p1');
        const state = renderState.get(exportId);
        return state ? { id: exportId, ...state } : { id: exportId, streamVideoUid: null, streamSourceObjectKey: null };
      },
      async setStreamProvenance(
        projectId: string,
        exportId: string,
        userId: string,
        key: string,
        videoUid: string,
      ) {
        expect(projectId).toBe('p1');
        expect(userId).toBe('dev-user');
        expect(key).toBe(sourceObjectKey);
        renderState.set(exportId, { streamVideoUid: videoUid, streamSourceObjectKey: key });
      },
    };

    const stream = {
      async upload(url: string, params?: Record<string, unknown>) {
        const parsed = new URL(url);
        const exportId = parsed.searchParams.get('render');
          ?? (params?.meta as { exportId?: string } | undefined)?.exportId
          ?? '';
        expect(exportId).toMatch(/^e[12]$/);
        uploadExportIds.push(exportId);
        return {
          id: `render-${exportId}`,
          readyToStream: false,
          status: { state: 'queued' },
        };
      },
      video(id: string) {
        if (id === 'shared-source') {
          throw new Error('shared source asset must never be mutated by export rendering');
        }
        expect(id).toMatch(/^render-e[12]$/);
        return {
          async details() {
            return { id, readyToStream: true, duration: 12.5, status: { state: 'ready' } };
          },
          downloads: {
            async generate(type?: string) { expect(type).toBe('default'); },
            async get() {
              return { default: { status: 'ready', url: `https://videodelivery.net/${id}.mp4` } };
            },
          },
        };
      },
    };

    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('https://api.cloudflare.com/')) apiUrls.push(url);
      const asset = url.match(/\/stream\/(render-e[12])(?:\/|$)/)?.[1];

      if (asset && method === 'GET' && url.endsWith('/audio')) {
        return Response.json({
          success: true,
          result: {
            audio: copied.has(asset)
              ? [{ uid: `audio-${asset}`, label: asset === 'render-e1' ? 'dubflow-vi-e1' : 'dubflow-ja-e2', status: 'ready' }]
              : [],
          },
        });
      }
      if (asset && method === 'POST' && url.endsWith('/audio/copy')) {
        copied.add(asset);
        return Response.json({
          success: true,
          result: {
            uid: `audio-${asset}`,
            label: asset === 'render-e1' ? 'dubflow-vi-e1' : 'dubflow-ja-e2',
            status: 'queued',
          },
        });
      }
      if (asset && method === 'PATCH' && url.endsWith(`/audio/audio-${asset}`)) {
        expect(JSON.parse(String(init?.body))).toEqual({ default: true });
        return Response.json({ success: true, result: { uid: `audio-${asset}`, default: true, status: 'ready' } });
      }
      if (method === 'GET' && /^https:\/\/videodelivery\.net\/render-e[12]\.mp4$/.test(url)) {
        return new Response(`mp4-${url.includes('e1') ? 'e1' : 'e2'}`, { status: 200 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    };

    const stored: string[] = [];
    const service = new StreamMediaService(({
      projects: {
        async getByIdForUser() { return project; },
        async setStreamProvenance() { throw new Error('export must not replace shared source provenance'); },
      },
      exportAssets,
      stream,
      bucket: {
        async put(key: string) {
          stored.push(key);
          return { key, size: 1 };
        },
      },
      publicOrigin: 'https://yupvox.qs3d.site',
      signingSecret: 'secret',
      accountId: 'account-1',
      apiToken: 'stream-token',
      fetcher,
      nowSeconds: () => 1_800_000_000,
      wait: async () => {},
    }) as never);

    await Promise.all([
      service.publishDubbedExport({
        projectId: 'p1', userId: 'dev-user', sourceObjectKey,
        soundtrackObjectKey: 'projects/p1/soundtracks/vi/e1.wav', targetLanguage: 'vi', exportId: 'e1',
        exportObjectKey: 'projects/p1/exports/vi/e1.mp4',
      }),
      service.publishDubbedExport({
        projectId: 'p1', userId: 'dev-user', sourceObjectKey,
        soundtrackObjectKey: 'projects/p1/soundtracks/ja/e2.wav', targetLanguage: 'ja', exportId: 'e2',
        exportObjectKey: 'projects/p1/exports/ja/e2.mp4',
      }),
    ]);

    expect(uploadExportIds.sort()).toEqual(['e1', 'e2']);
    expect(renderState.get('e1')?.streamVideoUid).toBe('render-e1');
    expect(renderState.get('e2')?.streamVideoUid).toBe('render-e2');
    expect(apiUrls.every((url) => !url.includes('/stream/shared-source/'))).toBe(true);
    expect(stored.sort()).toEqual([
      'projects/p1/exports/ja/e2.mp4',
      'projects/p1/exports/vi/e1.mp4',
    ]);
  });
});
