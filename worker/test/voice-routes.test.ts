import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import type { Env } from '../src/env';
import { createVoiceRoutes } from '../src/routes/voice';

type UsageInput = {
  userId: string;
  projectId: string | null;
  jobId: string | null;
  kind: string;
  units: number;
  provider: string;
  idempotencyKey?: string;
};
type UsageStore = { record(input: UsageInput): Promise<unknown> };
type UsageFactory = (env: Env) => UsageStore;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type VoiceFactory = (fetcher?: FetchLike, usageFactory?: UsageFactory) => ReturnType<typeof createVoiceRoutes>;

const ai = {
  async run() { return new Response('workers-ai'); },
} satisfies AiBinding;

function voiceEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: ai,
    ELEVENLABS_API_KEY: 'secret-key',
    ELEVENLABS_DEFAULT_VOICE_ID: 'voice-123',
    ...overrides,
  } as Env;
}

function routesWithUsage(fetcher: FetchLike, usage: UsageStore) {
  const factory = createVoiceRoutes as unknown as VoiceFactory;
  return factory(fetcher, () => usage);
}

function previewRequest(body: string) {
  return new Request('https://yupvox.test/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
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

  it('returns generated audio and records one ElevenLabs TTS usage event', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const records: UsageInput[] = [];
    const routes = routesWithUsage(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }, {
      async record(input) { records.push(input); return { inserted: true, event: input }; },
    });
    const response = await routes.fetch(previewRequest(JSON.stringify({ text: ' Xin chào ', language: 'vi' })), voiceEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/mpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      userId: 'dev-user', projectId: null, jobId: null,
      kind: 'tts_characters', units: 'Xin chào'.length, provider: 'elevenlabs',
    });
    expect(records[0].idempotencyKey).toMatch(/^request:.+:tts:preview$/);
  });

  it('returns USAGE_RECORD_FAILED and withholds audio when ledger persistence fails after provider success', async () => {
    let providerCalls = 0;
    const routes = routesWithUsage(async () => {
      providerCalls += 1;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }, {
      async record() { throw new Error('ledger unavailable'); },
    });

    const response = await routes.fetch(previewRequest(JSON.stringify({ text: 'Xin chào', language: 'vi' })), voiceEnv());

    expect(providerCalls).toBe(1);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ code: 'USAGE_RECORD_FAILED' });
  });

  it('fails closed with 503 when preview is not configured without metering', async () => {
    const records: UsageInput[] = [];
    const routes = routesWithUsage(async () => new Response('should-not-run'), {
      async record(input) { records.push(input); return { inserted: true, event: input }; },
    });
    const response = await routes.fetch(previewRequest(JSON.stringify({ text: 'Xin chào', language: 'vi' })), voiceEnv({ ELEVENLABS_API_KEY: undefined, ELEVENLABS_DEFAULT_VOICE_ID: undefined }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'VOICE_PROVIDER_UNCONFIGURED' });
    expect(records).toEqual([]);
  });

  it('rejects empty preview text before calling the provider or metering', async () => {
    let calls = 0;
    const records: UsageInput[] = [];
    const routes = routesWithUsage(async () => { calls += 1; return new Response('audio'); }, {
      async record(input) { records.push(input); return { inserted: true, event: input }; },
    });
    const response = await routes.fetch(previewRequest(JSON.stringify({ text: '   ', language: 'vi' })), voiceEnv());
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
    expect(records).toEqual([]);
  });

  it('does not meter invalid JSON or provider failure', async () => {
    for (const scenario of ['invalid-json', 'provider-failure'] as const) {
      const records: UsageInput[] = [];
      const routes = routesWithUsage(async () => {
        if (scenario === 'provider-failure') return new Response('down', { status: 503 });
        return new Response('should-not-run');
      }, {
        async record(input) { records.push(input); return { inserted: true, event: input }; },
      });
      const response = await routes.fetch(previewRequest(
        scenario === 'invalid-json' ? '{' : JSON.stringify({ text: 'Xin chào', language: 'vi' }),
      ), voiceEnv());
      expect(response.status).not.toBe(200);
      expect(records).toEqual([]);
    }
  });
});
