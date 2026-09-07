import { describe, expect, it } from 'vitest';

describe('provider media bearer tokens', () => {
  it('uses 256-bit randomness and persists only a SHA-256 hash', async () => {
    const modulePath = '../src/security/provider-media-token';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const secret = await loaded.createProviderMediaToken();
    expect(secret.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(loaded.hashProviderMediaToken(secret.token)).resolves.toBe(secret.tokenHash);
    expect(secret).not.toHaveProperty('tokenHint');
  });
});
