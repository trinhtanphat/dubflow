import { describe, expect, it } from 'vitest';
import { runVisualLipSync } from '../src/workflows/visualLipSync';

describe('zero-container visual lip-sync input', () => {
  it('grants Sync Labs the already-rendered standard MP4 and PCM soundtrack without FFmpeg audio extraction', async () => {
    const grantedKeys: string[] = [];
    const expired: string[] = [];
    const states: Array<{ status: string; objectKey?: string | null }> = [];
    const puts: string[] = [];
    let tokenIndex = 0;

    const deps = {
      exports: {
        async get() {
          return {
            status: 'completed',
            exportObjectKey: 'projects/p1/exports/vi/e1.mp4',
            lipSyncRequested: true,
            lipSyncProvider: null,
            lipSyncStatus: 'queued',
            lipSyncObjectKey: null,
          };
        },
        async setLipSyncState(_projectId: string, _exportId: string, _userId: string, state: { status: string; objectKey?: string | null }) {
          states.push(state);
        },
      },
      providerMediaGrants: {
        async create(input: { objectKey: string }) {
          grantedKeys.push(input.objectKey);
          return { id: `g${grantedKeys.length}` };
        },
        async expire(id: string) { expired.push(id); },
      },
      lipSync: {
        id: 'sync-labs',
        available: true,
        async render(input: { videoUrl: string; audioUrl: string }) {
          expect(input.videoUrl).toContain('/api/provider-media/g1');
          expect(input.audioUrl).toContain('/api/provider-media/g2');
          return { provider: 'sync-labs', providerJobId: 'sync-1', outputUrl: 'https://sync.example/output.mp4' };
        },
      },
      bucket: {
        async put(key: string) { puts.push(key); },
      },
      usage: {
        async getByOperation() { return null; },
        async record() {},
      },
      telemetry: { write() {} },
      async makeProviderMediaToken() {
        tokenIndex += 1;
        return { token: `token-${tokenIndex}`, tokenHash: String(tokenIndex).padStart(64, 'a').slice(0, 64) };
      },
      fetchImpl: async () => new Response('visual-mp4', { status: 200, headers: { 'content-type': 'video/mp4' } }),
      now: () => new Date('2026-09-07T02:30:00Z'),
    };

    await expect(runVisualLipSync({
      projectId: 'p1',
      userId: 'u1',
      jobId: 'j1',
      retryCount: 0,
      targetLanguage: 'vi',
      exportId: 'e1',
      standardObjectKey: 'projects/p1/exports/vi/e1.mp4',
      soundtrackObjectKey: 'projects/p1/soundtracks/vi/e1.wav',
      durationMs: 12_000,
    }, deps as never, { async do(_name, callback) { return callback(); } }, async () => {})).resolves.toBe(
      'projects/p1/exports/vi/e1.lipsync.mp4',
    );

    expect(grantedKeys).toEqual([
      'projects/p1/exports/vi/e1.mp4',
      'projects/p1/soundtracks/vi/e1.wav',
    ]);
    expect(puts).toEqual(['projects/p1/exports/vi/e1.lipsync.mp4']);
    expect(states.at(-1)).toMatchObject({ status: 'completed', objectKey: 'projects/p1/exports/vi/e1.lipsync.mp4' });
    expect(expired.sort()).toEqual(['g1', 'g2']);
  });
});
