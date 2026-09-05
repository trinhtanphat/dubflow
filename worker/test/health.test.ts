import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

describe('GET /api/health', () => {
  it('identifies the DubFlow foundation service', async () => {
    const response = await app.request('/api/health', {}, {} as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: 'dubflow', phase: 'foundation' });
  });
});
