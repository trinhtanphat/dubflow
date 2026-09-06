import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { VoiceClonePersistenceError, type VoiceClone, type VoiceCloneStore } from '../src/db/voice-clones';
import {
  parseVoiceCloneCreatePayload,
  assertVoiceCloneAssignable,
  createVoiceCloneRoutes,
} from '../src/routes/voice-clones';

const clone: VoiceClone = {
  id: 'clone-1',
  userId: 'dev-user',
  projectId: 'project-1',
  provider: 'elevenlabs',
  providerVoiceId: null,
  name: 'Narrator',
  status: 'creating',
  consentVersion: 'voice-clone-consent-v1',
  consentedAt: '2026-09-06T00:00:00Z',
  errorCode: null,
  createdAt: '2026-09-06T00:00:00Z',
  updatedAt: '2026-09-06T00:00:00Z',
};

function baseStore(overrides: Partial<VoiceCloneStore> = {}): VoiceCloneStore {
  return {
    async create() { return clone; },
    async list() { return [clone]; },
    async get() { return clone; },
    async markProviderResult() { return clone; },
    async markFailed() { return { ...clone, status: 'failed' }; },
    async markDeleting() { return { ...clone, status: 'deleting' }; },
    async markDeleted() { return { ...clone, status: 'deleted' }; },
    ...overrides,
  } as VoiceCloneStore;
}

describe('voice clone route contracts', () => {
  it('requires the exact affirmative consent contract', () => {
    expect(() => parseVoiceCloneCreatePayload({ name: 'Narrator' })).toThrowError(/consent/i);
    expect(() => parseVoiceCloneCreatePayload({
      name: 'Narrator',
      consentVersion: 'voice-clone-consent-v1',
      consentAcknowledged: false,
    })).toThrowError(/consent/i);
    expect(parseVoiceCloneCreatePayload({
      name: 'Narrator',
      consentVersion: 'voice-clone-consent-v1',
      consentAcknowledged: true,
    })).toEqual({ name: 'Narrator', consentVersion: 'voice-clone-consent-v1' });
  });

  it('allows assignment only for ready clones with a provider voice id', () => {
    expect(() => assertVoiceCloneAssignable({ status: 'verification_required', providerVoiceId: 'voice-1' })).toThrowError(/ready/i);
    expect(() => assertVoiceCloneAssignable({ status: 'failed', providerVoiceId: 'voice-1' })).toThrowError(/ready/i);
    expect(() => assertVoiceCloneAssignable({ status: 'ready', providerVoiceId: null })).toThrowError(/ready/i);
    expect(() => assertVoiceCloneAssignable({ status: 'ready', providerVoiceId: 'voice-1' })).not.toThrow();
  });

  it('maps hidden project ownership failures on clone lists to 404', async () => {
    const routes = createVoiceCloneRoutes(() => baseStore({
      async list() {
        throw new VoiceClonePersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
      },
    }));
    const response = await routes.fetch(new Request('https://yupvox.test/project-other-user/voice-clones'), {} as Env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'VOICE_CLONE_NOT_FOUND' });
  });

  it('returns a stable 400 for malformed clone creation JSON', async () => {
    const routes = createVoiceCloneRoutes(() => baseStore());
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/voice-clones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    }), {} as Env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_JSON' });
  });

  it('persists the validated sample content type into R2 HTTP metadata', async () => {
    const putCalls: Array<{ key: string; options: unknown }> = [];
    const routes = createVoiceCloneRoutes(() => baseStore());
    const env = {
      MEDIA: {
        async put(key: string, _value: unknown, options?: unknown) {
          putCalls.push({ key, options });
          return { key, size: 3 };
        },
      },
    } as Env;
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/voice-clones/clone-1/sample', {
      method: 'POST',
      headers: { 'content-type': 'audio/mpeg' },
      body: new Uint8Array([1, 2, 3]),
    }), env);

    expect(response.status).toBe(200);
    expect(putCalls).toEqual([{
      key: 'projects/project-1/voice-clones/clone-1/sample/current',
      options: { httpMetadata: { contentType: 'audio/mpeg' } },
    }]);
  });

  it('does not mark a local-only clone deleted when temporary sample cleanup fails', async () => {
    const markDeleted = vi.fn(async () => ({ ...clone, status: 'deleted' } as VoiceClone));
    const markFailed = vi.fn(async (_projectId: string, _cloneId: string, _userId: string, errorCode: string) => ({
      ...clone,
      status: 'failed',
      errorCode,
    } as VoiceClone));
    const routes = createVoiceCloneRoutes(() => baseStore({ markDeleted, markFailed }));
    const env = {
      MEDIA: {
        async delete() { throw new Error('R2 unavailable'); },
      },
    } as Env;
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/voice-clones/clone-1', {
      method: 'DELETE',
    }), env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'VOICE_CLONE_SAMPLE_CLEANUP_FAILED' });
    expect(markFailed).toHaveBeenCalledWith('project-1', 'clone-1', 'dev-user', 'VOICE_CLONE_SAMPLE_CLEANUP_FAILED');
    expect(markDeleted).not.toHaveBeenCalled();
  });
});
