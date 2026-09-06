import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShare, listShares, revokeShare } from './shareApi';

afterEach(() => vi.unstubAllGlobals());

describe('export sharing API', () => {
  it('creates a share through the encoded project route with the requested TTL', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json({
        share: {
          id: 's1', projectId: 'p / 1', tokenHint: 'abcd1234', exportObjectKey: 'projects/p / 1/export/final.mp4',
          expiresAt: '2026-09-13T00:00:00.000Z', revokedAt: null, createdAt: '2026-09-06T00:00:00.000Z', status: 'active',
        },
        shareUrl: 'https://studio.test/api/shares/s1/media?token=plain_secret',
      }, { status: 201 });
    });

    const result = await createShare('p / 1', 604800);

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('/api/projects/p%20%2F%201/shares');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(JSON.stringify({ expiresInSeconds: 604800 }));
    expect(result.shareUrl).toContain('token=plain_secret');
  });

  it('lists safe share metadata without synthesizing a bearer URL from tokenHint', async () => {
    vi.stubGlobal('fetch', async () => Response.json([{
      id: 's1', projectId: 'p1', tokenHint: 'abcd1234', exportObjectKey: 'projects/p1/export/final.mp4',
      expiresAt: '2026-09-13T00:00:00.000Z', revokedAt: null, createdAt: '2026-09-06T00:00:00.000Z', status: 'active',
    }]));

    const result = await listShares('p 1');

    expect(result).toEqual([expect.objectContaining({ id: 's1', tokenHint: 'abcd1234', status: 'active' })]);
    expect(result[0]).not.toHaveProperty('shareUrl');
    expect(JSON.stringify(result)).not.toContain('/api/shares/s1/media?token=');
  });

  it('revokes an encoded share id through the project-scoped route', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json({
        id: 's/1', projectId: 'p1', tokenHint: 'abcd1234', exportObjectKey: 'projects/p1/export/final.mp4',
        expiresAt: '2026-09-13T00:00:00.000Z', revokedAt: '2026-09-06T01:00:00.000Z', createdAt: '2026-09-06T00:00:00.000Z', status: 'revoked',
      });
    });

    await expect(revokeShare('p1', 's/1')).resolves.toMatchObject({ id: 's/1', status: 'revoked' });
    expect(calls[0].input).toBe('/api/projects/p1/shares/s%2F1');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('preserves stable API errors for sharing failures', async () => {
    vi.stubGlobal('fetch', async () => Response.json(
      { error: true, code: 'EXPORT_NOT_READY', message: 'Final export is not ready to share.' },
      { status: 409 },
    ));

    await expect(createShare('p1')).rejects.toMatchObject({
      status: 409,
      code: 'EXPORT_NOT_READY',
      message: 'Final export is not ready to share.',
    });
  });
});
