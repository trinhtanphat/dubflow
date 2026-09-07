import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createVisualExportMediaRoutes } from '../src/routes/visual-export-media';

function stream(bytes: number[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.from(bytes)); controller.close(); } });
}

const completedVisual = {
  id: 'e1',
  projectId: 'p1',
  targetLanguage: 'ja' as const,
  output: 'dubbed' as const,
  batchId: null,
  audioMode: 'dubbed_only' as const,
  status: 'completed' as const,
  exportObjectKey: 'projects/p1/exports/ja/e1.mp4',
  subtitleObjectKey: null,
  lipSyncRequested: true,
  lipSyncProvider: 'sync-labs',
  lipSyncStatus: 'completed' as const,
  lipSyncObjectKey: 'projects/p1/exports/ja/e1.lipsync.mp4',
  errorCode: null,
  errorMessage: null,
};

function appFor(attempt = completedVisual) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createVisualExportMediaRoutes({
    makeProjects: () => ({
      async getByIdForUser() {
        return { id: 'p1', userId: 'dev-user', status: 'completed', sourceObjectKey: 'projects/p1/source/a.mp4' };
      },
    }) as never,
    makeExports: () => ({
      async latestCompleted() { return attempt; },
    }) as never,
    makeBucket: () => ({
      async get(key: string) {
        expect(key).toBe('projects/p1/exports/ja/e1.lipsync.mp4');
        return { key, size: 3, body: stream([7, 8, 9]), httpMetadata: { contentType: 'video/mp4' } };
      },
    }) as never,
  }));
  return app;
}

describe('Phase 4E owner visual export media', () => {
  it('streams only the canonical completed lip-sync R2 artifact when visualMode=lip_sync', async () => {
    const response = await appFor().request(
      '/api/projects/p1/exports/ja/media?output=dubbed&visualMode=lip_sync',
      {},
      {} as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('p1-ja-lipsync.mp4');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([7, 8, 9]);
  });

  it('fails closed while the standard MP4 exists but the visual artifact is not completed', async () => {
    const attempt = { ...completedVisual, lipSyncStatus: 'failed' as const, lipSyncObjectKey: null };
    const app = new Hono<{ Bindings: Env }>();
    let bucketRead = false;
    app.route('/api/projects', createVisualExportMediaRoutes({
      makeProjects: () => ({ async getByIdForUser() { return { id: 'p1', userId: 'dev-user', status: 'completed' }; } }) as never,
      makeExports: () => ({ async latestCompleted() { return attempt; } }) as never,
      makeBucket: () => ({ async get() { bucketRead = true; return null; } }) as never,
    }));

    const response = await app.request(
      '/api/projects/p1/exports/ja/media?output=dubbed&visualMode=lip_sync',
      {},
      {} as Env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'LIP_SYNC_NOT_READY' });
    expect(bucketRead).toBe(false);
  });
});
