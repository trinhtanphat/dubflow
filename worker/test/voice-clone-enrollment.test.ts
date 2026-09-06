import { describe, expect, it, vi } from 'vitest';
import type { R2ObjectBodyLike } from '../src/cloudflare/r2';
import type { VoiceClone, VoiceCloneStore } from '../src/db/voice-clones';
import { enrollVoiceClone } from '../src/services/voice-clone/enrollment';
import { VoiceCloneProviderError, type VoiceCloneProvider } from '../src/services/voice-clone/types';

const clone: VoiceClone = {
  id: 'clone-1',
  userId: 'user-1',
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

function sample(): R2ObjectBodyLike {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    key: 'sample',
    size: bytes.byteLength,
    httpMetadata: { contentType: 'audio/mpeg' },
    body: new Blob([bytes]).stream(),
  };
}

function storeHarness() {
  const markProviderResult = vi.fn(async (_projectId: string, _cloneId: string, _userId: string, providerVoiceId: string, requiresVerification: boolean) => ({
    ...clone,
    providerVoiceId,
    status: requiresVerification ? 'verification_required' : 'ready',
    errorCode: requiresVerification ? 'VOICE_CLONE_VERIFICATION_REQUIRED' : null,
  } as VoiceClone));
  const markFailed = vi.fn(async (_projectId: string, _cloneId: string, _userId: string, errorCode: string) => ({
    ...clone,
    status: 'failed',
    errorCode,
  } as VoiceClone));
  return {
    store: { markProviderResult, markFailed } as unknown as VoiceCloneStore,
    markProviderResult,
    markFailed,
  };
}

describe('managed voice clone enrollment cleanup', () => {
  it.each([
    [false, 'ready'],
    [true, 'verification_required'],
  ] as const)('persists provider verification=%s as %s and deletes the temporary sample', async (requiresVerification, expectedStatus) => {
    const { store } = storeHarness();
    const remove = vi.fn(async () => undefined);
    const provider: VoiceCloneProvider = {
      createInstantClone: vi.fn(async () => ({ providerVoiceId: 'voice-123', requiresVerification })),
      deleteClone: vi.fn(async () => undefined),
    };

    const result = await enrollVoiceClone({
      clone,
      userId: 'user-1',
      store,
      bucket: { delete: remove } as any,
      sample: sample(),
      sampleKey: 'projects/project-1/voice-clones/clone-1/sample/current',
      provider,
    });

    expect(result.status).toBe(expectedStatus);
    expect(remove).toHaveBeenCalledWith('projects/project-1/voice-clones/clone-1/sample/current');
  });

  it('deletes the temporary sample and records a bounded failure when provider enrollment fails', async () => {
    const { store, markFailed } = storeHarness();
    const remove = vi.fn(async () => undefined);
    const provider: VoiceCloneProvider = {
      createInstantClone: vi.fn(async () => {
        throw new VoiceCloneProviderError('VOICE_CLONE_PROVIDER_FAILED', 'bounded');
      }),
      deleteClone: vi.fn(async () => undefined),
    };

    await expect(enrollVoiceClone({
      clone,
      userId: 'user-1',
      store,
      bucket: { delete: remove } as any,
      sample: sample(),
      sampleKey: 'sample-key',
      provider,
    })).rejects.toMatchObject({ code: 'VOICE_CLONE_PROVIDER_FAILED' });

    expect(markFailed).toHaveBeenCalledWith('project-1', 'clone-1', 'user-1', 'VOICE_CLONE_PROVIDER_FAILED');
    expect(remove).toHaveBeenCalledWith('sample-key');
  });

  it('deletes an orphaned provider voice if D1 persistence fails after provider creation', async () => {
    const { store, markProviderResult, markFailed } = storeHarness();
    markProviderResult.mockRejectedValueOnce(new Error('d1 write failed'));
    const remove = vi.fn(async () => undefined);
    const deleteClone = vi.fn(async () => undefined);
    const provider: VoiceCloneProvider = {
      createInstantClone: vi.fn(async () => ({ providerVoiceId: 'voice-orphan', requiresVerification: false })),
      deleteClone,
    };

    await expect(enrollVoiceClone({
      clone,
      userId: 'user-1',
      store,
      bucket: { delete: remove } as any,
      sample: sample(),
      sampleKey: 'sample-key',
      provider,
    })).rejects.toMatchObject({ code: 'VOICE_CLONE_PROVIDER_FAILED' });

    expect(deleteClone).toHaveBeenCalledWith('voice-orphan');
    expect(markFailed).toHaveBeenCalledWith('project-1', 'clone-1', 'user-1', 'VOICE_CLONE_PROVIDER_FAILED');
    expect(remove).toHaveBeenCalledWith('sample-key');
  });

  it('overrides a provider success with cleanup failure instead of returning a ready clone', async () => {
    const { store, markFailed } = storeHarness();
    const provider: VoiceCloneProvider = {
      createInstantClone: vi.fn(async () => ({ providerVoiceId: 'voice-123', requiresVerification: false })),
      deleteClone: vi.fn(async () => undefined),
    };

    await expect(enrollVoiceClone({
      clone,
      userId: 'user-1',
      store,
      bucket: { delete: vi.fn(async () => { throw new Error('r2 failure'); }) } as any,
      sample: sample(),
      sampleKey: 'sample-key',
      provider,
    })).rejects.toMatchObject({ code: 'VOICE_CLONE_SAMPLE_CLEANUP_FAILED' });

    expect(markFailed).toHaveBeenCalledWith('project-1', 'clone-1', 'user-1', 'VOICE_CLONE_SAMPLE_CLEANUP_FAILED');
  });
});
