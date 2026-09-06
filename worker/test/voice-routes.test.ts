import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import type { Env } from '../src/env';
import { createVoiceRoutes } from '../src/routes/voice';

const ai = {
  async run() { return new Response('workers-ai'); },
} satisfies AiBinding;

function voiceEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: ai,
    ANALYTICS: { writeDataPoint() {} },
    RATE_LIMIT_VOICE: { async limit() { return { success: true }; } },
    ELEVENLABS_API_KEY: 'secret-key',
    ELEVENLABS_DEFAULT_VOICE_ID: 'voice-123',
    ...overrides,
  } as Env;
}

describe('voice HTTP routes', () => {
  it('reports configured ElevenLabs preview capability without exposing secrets', async () => {
    const routes = createVoiceRoutes(async () => new Response('audio'));
    const response = await routes.fetch(new Request('https://yupvox.test/capabilities'), voiceEnv());
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual({
      provider: 'elevenlabs',
      configured: true,
      languages: ['vi'],
      cloning: true,
      preview: true,
    });
    expect(JSON.stringify(payload)).not.toContain('secret-key');
  });

  it('returns generated audio from POST /preview when the provider is configured', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const routes = createVoiceRoutes(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    });
    const response = await routes.fetch(new Request('https://yupvox.test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Xin chào', language: 'vi' }),
    }), voiceEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/mpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(1);
  });

  it('rejects a valid configured preview before provider work when rate limited', async () => {
    let providerCalls = 0;
    const limiterKeys: string[] = [];
    const routes = createVoiceRoutes(async () => {
      providerCalls += 1;
      return new Response('audio');
    });
    const response = await routes.fetch(new Request('https://yupvox.test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Xin chào', language: 'vi' }),
    }), voiceEnv({
      RATE_LIMIT_VOICE: {
        async limit({ key }: { key: string }) {
          limiterKeys.push(key);
          return { success: false };
        },
      } as Env['RATE_LIMIT_VOICE'],
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(limiterKeys).toEqual(['dev-user:voice']);
    expect(providerCalls).toBe(0);
  });

  it('fails closed with 503 when preview is not configured without consuming voice budget', async () => {
    let limiterCalls = 0;
    const routes = createVoiceRoutes(async () => new Response('should-not-run'));
    const response = await routes.fetch(new Request('https://yupvox.test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Xin chào', language: 'vi' }),
    }), voiceEnv({
      ELEVENLABS_API_KEY: undefined,
      ELEVENLABS_DEFAULT_VOICE_ID: undefined,
      RATE_LIMIT_VOICE: {
        async limit() { limiterCalls += 1; return { success: false }; },
      } as Env['RATE_LIMIT_VOICE'],
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'VOICE_PROVIDER_UNCONFIGURED' });
    expect(limiterCalls).toBe(0);
  });

  it('rejects empty preview text before calling the provider or consuming voice budget', async () => {
    let providerCalls = 0;
    let limiterCalls = 0;
    const routes = createVoiceRoutes(async () => { providerCalls += 1; return new Response('audio'); });
    const response = await routes.fetch(new Request('https://yupvox.test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ', language: 'vi' }),
    }), voiceEnv({
      RATE_LIMIT_VOICE: {
        async limit() { limiterCalls += 1; return { success: false }; },
      } as Env['RATE_LIMIT_VOICE'],
    }));
    expect(response.status).toBe(400);
    expect(providerCalls).toBe(0);
    expect(limiterCalls).toBe(0);
  });
});
