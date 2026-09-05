import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { checkRateLimit } from '../src/security/rate-limit';

function binding(keys: string[], success = true) {
  return {
    async limit(input: { key: string }) {
      keys.push(input.key);
      return { success };
    },
  };
}

function envFor(options: { process?: boolean; export?: boolean; translate?: boolean; voice?: boolean; upload?: boolean } = {}) {
  const keys = {
    process: [] as string[],
    export: [] as string[],
    translate: [] as string[],
    voice: [] as string[],
    upload: [] as string[],
  };
  const env = {
    RATE_LIMIT_PROCESS: binding(keys.process, options.process ?? true),
    RATE_LIMIT_EXPORT: binding(keys.export, options.export ?? true),
    RATE_LIMIT_TRANSLATE: binding(keys.translate, options.translate ?? true),
    RATE_LIMIT_VOICE: binding(keys.voice, options.voice ?? true),
    RATE_LIMIT_UPLOAD: binding(keys.upload, options.upload ?? true),
  } as Pick<Env,
    | 'RATE_LIMIT_PROCESS'
    | 'RATE_LIMIT_EXPORT'
    | 'RATE_LIMIT_TRANSLATE'
    | 'RATE_LIMIT_VOICE'
    | 'RATE_LIMIT_UPLOAD'
  >;
  return { env: env as Env, keys };
}

describe('Phase 3C rate-limit helper', () => {
  it('selects the operation binding and scopes the key by authenticated user plus operation', async () => {
    const { env, keys } = envFor();

    await expect(checkRateLimit(env, 'process', 'user-a')).resolves.toEqual({ allowed: true, retryAfterSeconds: 60 });
    await expect(checkRateLimit(env, 'export', 'user-a')).resolves.toEqual({ allowed: true, retryAfterSeconds: 60 });
    await expect(checkRateLimit(env, 'translate', 'user-a')).resolves.toEqual({ allowed: true, retryAfterSeconds: 60 });
    await expect(checkRateLimit(env, 'voice', 'user-a')).resolves.toEqual({ allowed: true, retryAfterSeconds: 60 });
    await expect(checkRateLimit(env, 'upload', 'user-a')).resolves.toEqual({ allowed: true, retryAfterSeconds: 60 });

    expect(keys).toEqual({
      process: ['user-a:process'],
      export: ['user-a:export'],
      translate: ['user-a:translate'],
      voice: ['user-a:voice'],
      upload: ['user-a:upload'],
    });
  });

  it('returns a 60-second rejection decision from the selected Cloudflare binding', async () => {
    const { env, keys } = envFor({ export: false });
    await expect(checkRateLimit(env, 'export', 'user-b')).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(keys.export).toEqual(['user-b:export']);
    expect(keys.process).toEqual([]);
  });

  it('rejects an empty authenticated actor before consuming any limiter', async () => {
    const { env, keys } = envFor();
    await expect(checkRateLimit(env, 'process', '   ')).rejects.toThrow('Rate-limit actor is required.');
    expect(Object.values(keys).flat()).toEqual([]);
  });
});
