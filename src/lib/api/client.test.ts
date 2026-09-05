import { describe, expect, it } from 'vitest';
import { apiFetch, ApiError } from './client';

describe('apiFetch', () => {
  it('returns decoded JSON for success', async () => {
    const result = await apiFetch<{ ok: boolean }>('/x', {}, async () => Response.json({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it('throws structured ApiError for API failures', async () => {
    await expect(apiFetch('/x', {}, async () => Response.json({ error: true, code: 'NOPE', message: 'bad' }, { status: 400 })))
      .rejects.toMatchObject({ status: 400, code: 'NOPE', message: 'bad' });
    expect(ApiError.name).toBe('ApiError');
  });
});
