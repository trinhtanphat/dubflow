import { describe, expect, it } from 'vitest';
import { StreamMediaService } from '../src/services/media/stream';

function streamVideo(uid = 'stream-1') {
  return {
    id: uid,
    readyToStream: true,
    readyToStreamAt: '2026-09-06T17:00:00Z',
    duration: 12.5,
    status: { state: 'ready' },
  };
}

describe('StreamMediaService', () => {
  it('reuses matching durable Stream provenance and generates a remote audio download', async () => {
    const uploads: string[] = [];
    const generateCalls: string[] = [];
    const project = {
      id: 'p1', userId: 'dev-user', sourceObjectKey: 'projects/p1/source/a.mp4',
      streamVideoUid: 'stream-existing', streamSourceObjectKey: 'projects/p1/source/a.mp4',
      streamReadyAt: '2026-09-06T16:50:00Z',
    };
    const projects = {
      async getByIdForUser() { return project; },
      async setStreamProvenance() { throw new Error('must reuse matching provenance'); },
    };
    const stream = {
      async upload(url: string) { uploads.push(url); return streamVideo(); },
      video(id: string) {
        expect(id).toBe('stream-existing');
        return {
          async details() { return streamVideo('stream-existing'); },
          downloads: {
            async generate(type?: string) { generateCalls.push(type ?? 'default'); },
            async get() {
              return { audio: { status: 'ready', percentComplete: 100, url: 'https://videodelivery.net/audio.m4a' } };
            },
          },
        };
      },
    };

    const service = new StreamMediaService({
      projects: projects as never,
      stream: stream as never,
      publicOrigin: 'https://yupvox.qs3d.site',
      signingSecret: 'secret',
      nowSeconds: () => 1_800_000_000,
      wait: async () => {},
    });
    await expect(service.prepareSource('p1', 'dev-user', project.sourceObjectKey)).resolves.toEqual({
      sourceId: 'stream-existing',
      durationMs: 12_500,
      audioUrl: 'https://videodelivery.net/audio.m4a',
    });
    expect(uploads).toEqual([]);
    expect(generateCalls).toEqual(['audio']);
  });

  it('ingests a signed private R2 source when provenance is stale and persists the new Stream uid', async () => {
    const uploads: string[] = [];
    const persisted: unknown[] = [];
    const project = {
      id: 'p1', userId: 'dev-user', sourceObjectKey: 'projects/p1/source/new.mp4',
      streamVideoUid: 'old', streamSourceObjectKey: 'projects/p1/source/old.mp4', streamReadyAt: null,
    };
    const projects = {
      async getByIdForUser() { return project; },
      async setStreamProvenance(...args: unknown[]) { persisted.push(args); },
    };
    const stream = {
      async upload(url: string) { uploads.push(url); return streamVideo('new-stream'); },
      video(id: string) {
        expect(id).toBe('new-stream');
        return {
          async details() { return streamVideo('new-stream'); },
          downloads: {
            async generate() {},
            async get() {
              return { audio: { status: 'ready', percentComplete: 100, url: 'https://videodelivery.net/new-audio.m4a' } };
            },
          },
        };
      },
    };
    const service = new StreamMediaService({
      projects: projects as never,
      stream: stream as never,
      publicOrigin: 'https://yupvox.qs3d.site',
      signingSecret: 'secret',
      nowSeconds: () => 1_800_000_000,
      wait: async () => {},
    });

    const prepared = await service.prepareSource('p1', 'dev-user', project.sourceObjectKey);
    expect(prepared.sourceId).toBe('new-stream');
    expect(uploads).toHaveLength(1);
    const sourceUrl = new URL(uploads[0]);
    expect(sourceUrl.origin + sourceUrl.pathname).toBe('https://yupvox.qs3d.site/api/stream-source/p1');
    expect(sourceUrl.searchParams.get('key')).toBe(project.sourceObjectKey);
    expect(Number(sourceUrl.searchParams.get('expires'))).toBeGreaterThan(1_800_000_000);
    expect(sourceUrl.searchParams.get('signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted).toEqual([[
      'p1', 'dev-user', project.sourceObjectKey, 'new-stream', '2026-09-06T17:00:00Z',
    ]]);
  });
});
