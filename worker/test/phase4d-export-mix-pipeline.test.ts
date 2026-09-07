import { describe, expect, it, vi } from 'vitest';
import type { UsageEvent, UsagePhase, UsageRecordInput } from '../src/db/usage';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

function harness(currentSeparation: any) {
  const usageEvents: UsageRecordInput[] = [];
  const canonical = new Map<string, UsageEvent>();
  const project = {
    id: 'p1', userId: 'dev-user', sourceObjectKey: 'projects/p1/source/video.mp4',
    sourceRevision: 2, durationMs: 10_000,
  };
  const sourceSegments = [{
    id: 's1', projectId: 'p1', speakerId: null, startMs: 0, endMs: 2_000,
    sourceText: 'Hello', translatedText: 'legacy', translationStatus: 'completed',
    voiceStatus: 'pending', dubbedObjectKey: null, version: 1,
  }];
  const variants = [{
    segmentId: 's1', projectId: 'p1', targetLanguage: 'ja' as const,
    translatedText: 'こんにちは', translationEngine: 'workers-ai', translationStatus: 'completed',
    translationContextRevision: 1, voiceStatus: 'completed',
    dubbedObjectKey: 'projects/p1/voices/ja/s1/1.mp3', version: 1,
  }];
  const usage = {
    record: vi.fn(async (input: UsageRecordInput) => {
      usageEvents.push(input);
      const key = `${input.operationKey}|${input.phase}`;
      const event = { ...input, id: `usage-${canonical.size + 1}`, costBasis: 0, createdAt: '2026-09-07T00:00:00Z' } satisfies UsageEvent;
      if (!canonical.has(key)) canonical.set(key, event);
      return canonical.get(key)!;
    }),
    getByOperation: vi.fn(async (operationKey: string, phase: UsagePhase) => canonical.get(`${operationKey}|${phase}`) ?? null),
  };
  const deps = {
    projects: {
      getByIdForUser: vi.fn(async () => project),
      setStatus: vi.fn(async () => {}),
      setExportObject: vi.fn(async () => {}),
    },
    jobs: {
      getForProject: vi.fn(async () => ({ status: 'running' as const, retryCount: 0 })),
      setProgress: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    },
    segments: {
      list: vi.fn(async () => sourceSegments),
      setVoiceResult: vi.fn(async () => {}),
    },
    translations: {
      list: vi.fn(async () => variants),
      setVoiceResult: vi.fn(async () => {}),
    },
    exports: {
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    },
    separations: {
      getCurrent: vi.fn(async () => currentSeparation),
    },
    separationCapabilities: {
      configured: true,
      qualified: true,
      provider: 'demucs-container',
      modelId: 'htdemucs',
      modelDigest: 'sha256:8726e21a',
    },
    speakers: { list: vi.fn(async () => []) },
    bucket: { put: vi.fn(async () => ({})) },
    voice: { generate: vi.fn() },
    media: {
      probe: vi.fn(async () => ({ durationMs: 10_000 })),
      renderExport: vi.fn(async (_projectId: string, _source: string, _clips: unknown[], options?: { targetLanguage: string; exportId: string }) => ({
        exportObjectKey: `projects/p1/exports/${options?.targetLanguage}/${options?.exportId}.mp4`,
      })),
    },
    usage,
    telemetry: { write: vi.fn() },
  };
  return { deps, usageEvents };
}

const preserveParams = {
  projectId: 'p1', userId: 'dev-user', jobId: 'j1', exportId: 'exp-1',
  targetLanguage: 'ja', output: 'dubbed', mixMode: 'preserve_background',
} as const;

const validSeparation = {
  id: 'sep-1', projectId: 'p1', sourceRevision: 2,
  sourceObjectKey: 'projects/p1/source/video.mp4', sourceSizeBytes: 123,
  provider: 'demucs-container', modelId: 'htdemucs', modelDigest: 'sha256:8726e21a',
  status: 'completed',
  backgroundObjectKey: 'projects/p1/separation/2/demucs-container/sha256-8726e21a/background.wav',
  dialogueObjectKey: 'projects/p1/separation/2/demucs-container/sha256-8726e21a/dialogue.wav',
  jobId: 'sep-job', errorCode: null, errorMessage: null,
  createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z', completedAt: '2026-09-07T00:00:00Z',
};

describe('Phase 4D preserve-background export pipeline', () => {
  it('revalidates the current separation at Workflow execution and passes only its canonical background key to rendering', async () => {
    const h = harness(validSeparation);

    await runExportPipeline(preserveParams as never, h.deps as never, step() as never);

    expect(h.deps.separations.getCurrent).toHaveBeenCalledWith(
      'p1', 'dev-user', 2, 'demucs-container', 'sha256:8726e21a',
    );
    expect(h.deps.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/video.mp4',
      [{ segmentId: 's1', startMs: 0, endMs: 2_000, objectKey: 'projects/p1/voices/ja/s1/1.mp3' }],
      {
        targetLanguage: 'ja',
        exportId: 'exp-1',
        mixMode: 'preserve_background',
        backgroundObjectKey: validSeparation.backgroundObjectKey,
      },
    );
  });

  it('fails closed with a stable separation code when the current separation disappeared before Workflow render', async () => {
    const h = harness(null);

    await expect(runExportPipeline(preserveParams as never, h.deps as never, step() as never))
      .rejects.toMatchObject({ code: 'SEPARATION_UNAVAILABLE' });

    expect(h.deps.media.renderExport).not.toHaveBeenCalled();
    expect(h.deps.jobs.fail).toHaveBeenCalledWith('j1', 'SEPARATION_UNAVAILABLE', expect.any(String));
    expect(h.deps.exports.fail).toHaveBeenCalledWith('p1', 'exp-1', 'dev-user', 'SEPARATION_UNAVAILABLE', expect.any(String));
  });
});
