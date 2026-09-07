import { describe, expect, it } from 'vitest';
import { R2SourceMediaService } from '../src/services/media/r2-source';
import { verifyMediaSourceToken } from '../src/security/media-source-token';

describe('R2 source media service', () => {
  it('creates a short-lived signed source URL without any Stream binding', async () => {
    const sourceObjectKey = 'projects/project-1/source/movie.mp4';
    const service = new R2SourceMediaService({
      projects: {
        async getByIdForUser() {
          return { id: 'project-1', sourceObjectKey, durationMs: 12_500 };
        },
      },
      publicOrigin: 'https://yupvox.qs3d.site',
      signingSecret: 'media-secret',
      nowSeconds: () => 1_000,
    });

    const result = await service.prepareSource('project-1', 'dev-user', sourceObjectKey);
    expect(result.sourceId).toBe(sourceObjectKey);
    expect(result.durationMs).toBe(12_500);
    const url = new URL(result.audioUrl);
    expect(url.origin).toBe('https://yupvox.qs3d.site');
    expect(url.pathname).toBe('/api/media-source/project-1');
    expect(url.searchParams.get('key')).toBe(sourceObjectKey);
    expect(url.searchParams.get('expires')).toBe('1900');
    expect(await verifyMediaSourceToken({
      secret: 'media-secret',
      projectId: 'project-1',
      objectKey: sourceObjectKey,
      expires: 1_900,
      signature: url.searchParams.get('signature') ?? '',
      nowSeconds: 1_000,
    })).toBe(true);
  });

  it('fails if the project source changed and does not trust invalid stored duration', async () => {
    const service = new R2SourceMediaService({
      projects: {
        async getByIdForUser() {
          return { id: 'project-1', sourceObjectKey: 'projects/project-1/source/new.mp4', durationMs: -1 };
        },
      },
      publicOrigin: 'https://yupvox.qs3d.site',
      signingSecret: 'media-secret',
      nowSeconds: () => 1_000,
    });
    await expect(service.prepareSource('project-1', 'dev-user', 'projects/project-1/source/old.mp4'))
      .rejects.toThrow(/MEDIA_SOURCE_CHANGED/);
  });
});
