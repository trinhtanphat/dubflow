import { describe, expect, it } from 'vitest';
import { apiFetch, ApiError } from './client';

describe('apiFetch', () => {
  it('returns decoded JSON for success', async () => {
    const result = await apiFetch<{ ok: boolean }>('/x', {}, async () => Response.json({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it('throws structured ApiError and preserves the parsed JSON payload', async () => {
    const payload = { error: true, code: 'NOPE', message: 'bad', segment: { id: 's1' } };
    await expect(apiFetch('/x', {}, async () => Response.json(payload, { status: 400 })))
      .rejects.toMatchObject({ status: 400, code: 'NOPE', message: 'bad', payload });
    expect(ApiError.name).toBe('ApiError');
  });
});
