import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShare } from './shareApi';

afterEach(() => vi.unstubAllGlobals());

describe('Phase 4C concrete export share API', () => {
  it('includes the selected export id without changing the existing TTL contract', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json({
        share: {
          id: 's1', projectId: 'p / 1', exportId: 'ja / 1', tokenHint: 'abcd1234',
          exportObjectKey: 'projects/p / 1/exports/ja/ja / 1.mp4', expiresAt: '2026-09-13T00:00:00.000Z',
          revokedAt: null, createdAt: '2026-09-06T00:00:00.000Z', status: 'active',
        },
        shareUrl: 'https://yupvox.qs3d.site/api/shares/s1/media?token=plain_secret',
      }, { status: 201 });
    });

    const call = createShare as unknown as (projectId: string, expiresInSeconds?: number, exportId?: string) => Promise<unknown>;
    await call('p / 1', 604800, 'ja / 1');

    expect(calls[0].input).toBe('/api/projects/p%20%2F%201/shares');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(JSON.stringify({ expiresInSeconds: 604800, exportId: 'ja / 1' }));
  });
});
