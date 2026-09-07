import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import type { Env } from '../src/env';
import type { VoiceClone, VoiceCloneStore } from '../src/db/voice-clones';
import { createVoiceCloneRoutes } from '../src/routes/voice-clones';
import { createVoiceRoutes } from '../src/routes/voice';
import { createVoiceProvider } from '../src/services/voice/provider';

const ai = {
  async run() { return new Response('workers-ai'); },
} satisfies AiBinding;

const clone: VoiceClone = {
  id: 'clone-1',
  userId: 'dev-user',
  projectId: 'project-1',
  provider: 'elevenlabs',
  providerVoiceId: null,
  name: 'Narrator',
  status: 'creating',
  consentVersion: 'voice-clone-consent-v1',
  consentedAt: '2026-09-07T00:00:00Z',
  errorCode: null,
  createdAt: '2026-09-07T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
};

function cloneStore(row: VoiceClone = clone): VoiceCloneStore {
  return {
    async create() { return row; },
    async list() { return [row]; },
    async get() { return row; },
    async markProviderResult() { return row; },
    async markFailed() { return { ...row, status: 'failed' }; },
    async markDeleting() { return { ...row, status: 'deleting' }; },
    async markDeleted() { return { ...row, status: 'deleted' }; },
  } as VoiceCloneStore;
}

function paidCredentialsEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: ai,
    ANALYTICS: { writeDataPoint() {} },
    RATE_LIMIT_VOICE: { async limit() { return { success: true }; } },
    RATE_LIMIT_VOICE_CLONE: { async limit() { return { success: true }; } },
    ELEVENLABS_API_KEY: 'secret-key',
    ELEVENLABS_DEFAULT_VOICE_ID: 'voice-123',
    MEDIA: {
      async get() { return null; },
    },
    ...overrides,
  } as unknown as Env;
}

describe('paid ElevenLabs opt-in', () => {
  it('does not select ElevenLabs TTS merely because paid credentials exist', () => {
    const provider = createVoiceProvider({
      AI: ai,
      ELEVENLABS_API_KEY: 'secret-key',
      ELEVENLABS_DEFAULT_VOICE_ID: 'voice-123',
    });

    expect(provider.capabilities()).toEqual(expect.objectContaining({
      provider: 'workers-ai',
      configured: false,
      languages: 'unknown',
    }));
  });

  it('does not advertise or call paid ElevenLabs preview without explicit opt-in', async () => {
    let providerCalls = 0;
    const routes = createVoiceRoutes(async () => {
      providerCalls += 1;
      return new Response('audio');
    });
    const env = paidCredentialsEnv();

    const capabilities = await routes.fetch(new Request('https://yupvox.test/capabilities'), env);
    expect(capabilities.status).toBe(200);
    await expect(capabilities.json()).resolves.toMatchObject({
      provider: 'workers-ai',
      configured: false,
      preview: false,
    });

    const preview = await routes.fetch(new Request('https://yupvox.test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Xin chào', language: 'vi' }),
    }), env);
    expect(preview.status).toBe(503);
    await expect(preview.json()).resolves.toMatchObject({ code: 'VOICE_PROVIDER_UNCONFIGURED' });
    expect(providerCalls).toBe(0);
  });

  it('rejects paid ElevenLabs clone enrollment before R2/provider work without explicit opt-in', async () => {
    let mediaReads = 0;
    const routes = createVoiceCloneRoutes(() => cloneStore());
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/voice-clones/clone-1/enroll', {
      method: 'POST',
    }), paidCredentialsEnv({
      MEDIA: {
        async get() {
          mediaReads += 1;
          return null;
        },
      } as unknown as Env['MEDIA'],
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'VOICE_CLONE_PROVIDER_UNCONFIGURED' });
    expect(mediaReads).toBe(0);
  });

  it('rejects paid ElevenLabs remote clone deletion before local cleanup without explicit opt-in', async () => {
    let mediaDeletes = 0;
    let providerDeletes = 0;
    const remoteClone = { ...clone, status: 'ready', providerVoiceId: 'voice-remote-1' } as VoiceClone;
    const routes = createVoiceCloneRoutes(
      () => cloneStore(remoteClone),
      () => ({
        async enroll() { throw new Error('should-not-enroll'); },
        async deleteClone() { providerDeletes += 1; },
      } as never),
    );
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/voice-clones/clone-1', {
      method: 'DELETE',
    }), paidCredentialsEnv({
      MEDIA: {
        async delete() { mediaDeletes += 1; },
      } as unknown as Env['MEDIA'],
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'VOICE_CLONE_PROVIDER_UNCONFIGURED' });
    expect(mediaDeletes).toBe(0);
    expect(providerDeletes).toBe(0);
  });
});
