import { describe, expect, it, vi } from 'vitest';
import { LipSyncProviderError } from '../src/services/lipsync/types';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function workflowStep() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

function durableWorkflowStep() {
  return {
    do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => {
      const result = await callback();
      if (result instanceof Response) {
        throw new TypeError('Workflow step returned a non-serializable Response.');
      }
      return result;
    }),
  };
}

function secretSafeWorkflowStep() {
  return {
    do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => {
      const result = await callback();
      if (result && typeof result === 'object' && 'token' in result) {
        throw new TypeError('Workflow step persisted a plaintext provider-media token.');
      }
      return result;
    }),
  };
}

function harness(options: { providerFails?: boolean; completedLipSync?: boolean } = {}) {
  const usage = new Map<string, any>();
  const usageEvents: any[] = [];
  const standardKey = 'projects/p1/exports/ja/e1.mp4';
  const audioKey = 'projects/p1/exports/ja/e1.audio.wav';
  const lipSyncKey = 'projects/p1/exports/ja/e1.lipsync.mp4';
  const exportState: any = {
    id: 'e1', projectId: 'p1', targetLanguage: 'ja', output: 'dubbed', batchId: null,
    audioMode: 'dubbed_only', status: 'completed', exportObjectKey: standardKey, subtitleObjectKey: null,
    lipSyncRequested: true, lipSyncProvider: options.completedLipSync ? 'sync-labs' : null,
    lipSyncStatus: options.completedLipSync ? 'completed' : 'queued',
    lipSyncObjectKey: options.completedLipSync ? lipSyncKey : null,
    errorCode: null, errorMessage: null,
  };
  const completedCalls: any[] = [];
  const lipStates: any[] = [];
  const grantExpirations: string[] = [];
  let grantIndex = 0;
  const deps: any = {
    projects: {
      getByIdForUser: vi.fn(async () => ({
        id: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4', durationMs: 10_000, sourceGeneration: 1,
      })),
      setStatus: vi.fn(async () => {}),
      setExportObject: vi.fn(async () => {}),
    },
    jobs: {
      getForProject: vi.fn(async () => ({ status: 'running', retryCount: 2 })),
      setProgress: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    },
    segments: {
      list: vi.fn(async () => [{
        id: 's1', speakerId: null, startMs: 0, endMs: 1_000, translatedText: 'legacy',
        voiceStatus: 'completed', dubbedObjectKey: 'projects/p1/dubbed/s1.mp3', version: 1,
      }]),
      setVoiceResult: vi.fn(async () => {}),
    },
    translations: {
      list: vi.fn(async () => [{
        segmentId: 's1', targetLanguage: 'ja', translatedText: 'こんにちは', translationStatus: 'completed',
        voiceStatus: 'completed', dubbedObjectKey: 'projects/p1/voices/ja/s1/1.mp3', version: 1,
      }]),
      setVoiceResult: vi.fn(async () => {}),
    },
    exports: {
      get: vi.fn(async () => exportState),
      complete: vi.fn(async (_projectId: string, _exportId: string, _userId: string, keys: any) => {
        completedCalls.push(keys);
        exportState.status = 'completed';
        if (keys.exportObjectKey) exportState.exportObjectKey = keys.exportObjectKey;
      }),
      setLipSyncState: vi.fn(async (_projectId: string, _exportId: string, _userId: string, state: any) => {
        lipStates.push(state);
        exportState.lipSyncRequested = state.requested;
        exportState.lipSyncProvider = state.provider;
        exportState.lipSyncStatus = state.status;
        exportState.lipSyncObjectKey = state.objectKey ?? null;
      }),
      fail: vi.fn(async () => {}),
    },
    speakers: { list: vi.fn(async () => []) },
    bucket: {
      put: vi.fn(async () => ({ key: lipSyncKey, size: 3 })),
    },
    voice: { generate: vi.fn() },
    media: {
      probe: vi.fn(async () => ({ durationMs: 10_000 })),
      renderExport: vi.fn(async () => ({ exportObjectKey: standardKey })),
      extractExportAudio: vi.fn(async () => ({ audioObjectKey: audioKey })),
    },
    providerMediaGrants: {
      create: vi.fn(async ({ objectKey }: any) => ({
        id: `grant-${++grantIndex}`, projectId: 'p1', objectKey,
        expiresAt: '2026-09-07T01:00:00.000Z', consumedAt: null, createdAt: '2026-09-07T00:45:00.000Z',
      })),
      expire: vi.fn(async (grantId: string) => { grantExpirations.push(grantId); }),
    },
    makeProviderMediaToken: vi.fn(async () => ({ token: `token-${grantIndex + 1}`, tokenHash: 'a'.repeat(64) })),
    providerMediaOrigin: 'https://yupvox.qs3d.site',
    lipSync: {
      id: 'sync-labs',
      available: true,
      render: vi.fn(async () => {
        if (options.providerFails) throw new LipSyncProviderError('LIP_SYNC_FAILED', 'provider failed');
        return { provider: 'sync-labs', providerJobId: 'sync-job-1', outputUrl: 'https://provider.example/output.mp4' };
      }),
    },
    fetchImpl: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    })),
    usage: {
      getByOperation: vi.fn(async (key: string, phase: string) => usage.get(`${key}|${phase}`) ?? null),
      record: vi.fn(async (input: any) => {
        usageEvents.push(input);
        const event = { ...input, id: `u-${usage.size + 1}`, costBasis: 0, createdAt: '2026-09-07T00:45:00Z' };
        const key = `${input.operationKey}|${input.phase}`;
        if (!usage.has(key)) usage.set(key, event);
        return usage.get(key);
      }),
    },
    telemetry: { write: vi.fn(async () => {}) },
  };
  return { deps, usageEvents, exportState, completedCalls, lipStates, grantExpirations, standardKey, audioKey, lipSyncKey };
}

const standardParams = {
  projectId: 'p1', userId: 'dev-user', jobId: 'j1', exportId: 'e1', targetLanguage: 'ja', output: 'dubbed',
  audioMode: 'dubbed_only', visualMode: 'standard',
} as const;

const lipSyncParams = { ...standardParams, visualMode: 'lip_sync' } as const;

describe('Phase 4E durable visual lip-sync export orchestration', () => {
  it('never invokes lip-sync work for a standard dubbed export', async () => {
    const h = harness();
    await runExportPipeline(standardParams as never, h.deps, workflowStep() as never);
    expect(h.deps.lipSync.render).not.toHaveBeenCalled();
    expect(h.deps.providerMediaGrants.create).not.toHaveBeenCalled();
    expect(h.deps.media.extractExportAudio).not.toHaveBeenCalled();
  });

  it('keeps provider download results serializable across durable Workflow step boundaries', async () => {
    const h = harness();
    await runExportPipeline(lipSyncParams as never, h.deps, durableWorkflowStep() as never);
    expect(h.deps.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.deps.bucket.put).toHaveBeenCalledTimes(1);
  });

  it('never persists plaintext provider-media bearer tokens as durable step results', async () => {
    const h = harness();
    await runExportPipeline(lipSyncParams as never, h.deps, secretSafeWorkflowStep() as never);
    expect(h.deps.makeProviderMediaToken).toHaveBeenCalledTimes(2);
    expect(h.deps.lipSync.render).toHaveBeenCalledTimes(1);
  });

  it('starts visual processing only after the normal dubbed artifact exists and publishes canonical R2 output', async () => {
    const h = harness();
    await runExportPipeline(lipSyncParams as never, h.deps, workflowStep() as never);

    expect(h.deps.exports.complete).toHaveBeenCalledWith('p1', 'e1', 'dev-user', { exportObjectKey: h.standardKey });
    expect(h.deps.media.extractExportAudio).toHaveBeenCalledWith('p1', h.standardKey, 'ja', 'e1');
    expect(h.deps.providerMediaGrants.create).toHaveBeenCalledTimes(2);
    expect(h.deps.lipSync.render).toHaveBeenCalledWith({
      videoUrl: expect.stringMatching(/^https:\/\/yupvox\.qs3d\.site\/api\/provider-media\/grant-1\?token=/),
      audioUrl: expect.stringMatching(/^https:\/\/yupvox\.qs3d\.site\/api\/provider-media\/grant-2\?token=/),
    });
    expect(h.deps.fetchImpl).toHaveBeenCalledWith('https://provider.example/output.mp4', expect.objectContaining({ redirect: 'follow' }));
    expect(h.deps.bucket.put).toHaveBeenCalledWith(
      h.lipSyncKey,
      expect.any(ReadableStream),
      expect.objectContaining({ httpMetadata: { contentType: 'video/mp4' } }),
    );
    expect(h.lipStates).toContainEqual(expect.objectContaining({ requested: true, provider: 'sync-labs', status: 'completed', objectKey: h.lipSyncKey }));
    expect(h.grantExpirations).toEqual(['grant-1', 'grant-2']);
    expect(h.usageEvents.filter((event) => event.kind === 'lip_sync_video_second')).toEqual([
      expect.objectContaining({ phase: 'started', units: 10, provider: 'sync-labs', operationKey: 'job:j1:retry:2:lipsync:ja:e1:sync-labs' }),
      expect.objectContaining({ phase: 'completed', units: 10, provider: 'sync-labs', operationKey: 'job:j1:retry:2:lipsync:ja:e1:sync-labs' }),
    ]);
  });

  it('preserves the completed normal dubbed artifact when provider processing fails', async () => {
    const h = harness({ providerFails: true });
    await expect(runExportPipeline(lipSyncParams as never, h.deps, workflowStep() as never))
      .rejects.toMatchObject({ code: 'LIP_SYNC_FAILED' });

    expect(h.completedCalls).toContainEqual({ exportObjectKey: h.standardKey });
    expect(h.deps.exports.fail).not.toHaveBeenCalled();
    expect(h.exportState.exportObjectKey).toBe(h.standardKey);
    expect(h.lipStates).toContainEqual(expect.objectContaining({ requested: true, provider: 'sync-labs', status: 'failed' }));
    expect(h.grantExpirations).toEqual(['grant-1', 'grant-2']);
  });

  it('reuses an already completed canonical lip-sync artifact without provider or duplicate usage', async () => {
    const h = harness({ completedLipSync: true });
    await runExportPipeline(lipSyncParams as never, h.deps, workflowStep() as never);

    expect(h.deps.lipSync.render).not.toHaveBeenCalled();
    expect(h.deps.providerMediaGrants.create).not.toHaveBeenCalled();
    expect(h.usageEvents.some((event) => event.kind === 'lip_sync_video_second')).toBe(false);
    expect(h.exportState.lipSyncObjectKey).toBe(h.lipSyncKey);
  });
});
