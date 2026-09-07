import { describe, expect, it, vi } from 'vitest';
import type { UsageEvent, UsagePhase, UsageRecordInput } from '../src/db/usage';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

type HarnessOptions = {
  reusableStem?: {
    id: string;
    projectId: string;
    sourceGeneration: number;
    kind: 'background';
    provider: string;
    providerVersion: string | null;
    status: 'completed';
    objectKey: string;
    errorCode: null;
    errorMessage: null;
    createdAt: string;
    updatedAt: string;
  } | null;
  separationQualification?: 'qualified' | 'unqualified' | 'unavailable';
  separationConfigured?: boolean;
  separationProvider?: string | null;
  completedSeparationAccounting?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const usageEvents: UsageRecordInput[] = [];
  const canonical = new Map<string, UsageEvent>();
  const project = {
    id: 'p1', userId: 'dev-user', sourceObjectKey: 'projects/p1/source/video.mp4', durationMs: 10_000,
    sourceGeneration: 3,
  };
  const sourceSegments = [{
    id: 's1', projectId: 'p1', speakerId: null, startMs: 0, endMs: 2_000,
    sourceText: '你好', translatedText: 'VI legacy must not be used', translationStatus: 'completed',
    voiceStatus: 'pending', dubbedObjectKey: null, version: 3,
  }];
  const jaVariants = [{
    segmentId: 's1', projectId: 'p1', targetLanguage: 'ja' as const,
    translatedText: 'こんにちは', translationEngine: 'workers-ai', translationStatus: 'completed',
    translationContextRevision: 8, voiceStatus: 'pending', dubbedObjectKey: null as string | null, version: 3,
  }];
  const usage = {
    record: vi.fn(async (input: UsageRecordInput) => {
      usageEvents.push(input);
      const key = `${input.operationKey}|${input.phase}`;
      const event = { ...input, id: `usage-${canonical.size + 1}`, costBasis: 0, createdAt: '2026-09-06T00:00:00Z' } satisfies UsageEvent;
      if (!canonical.has(key)) canonical.set(key, event);
      return canonical.get(key)!;
    }),
    getByOperation: vi.fn(async (operationKey: string, phase: UsagePhase) => canonical.get(`${operationKey}|${phase}`) ?? null),
  };
  const provider = options.separationProvider === undefined ? 'qualified-provider' : options.separationProvider;
  const qualification = options.separationQualification ?? 'qualified';
  const configured = options.separationConfigured ?? qualification === 'qualified';
  const reusableStem = options.reusableStem ?? null;
  const pendingStem = {
    id: 'stem-pending-1', projectId: 'p1', sourceGeneration: 3, kind: 'background' as const,
    provider: provider ?? 'qualified-provider', providerVersion: null, status: 'pending' as const,
    objectKey: null, errorCode: null, errorMessage: null,
    createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z',
  };
  const separationOperationKey = `project:p1:source:3:dialogue-separation:${provider ?? 'qualified-provider'}`;
  if (options.completedSeparationAccounting) {
    const completed = {
      id: 'usage-existing', userId: 'dev-user', projectId: 'p1', jobId: 'j-ja',
      kind: 'dialogue_separation_second' as never, units: 10, provider: provider ?? 'qualified-provider',
      phase: 'completed' as const, operationKey: separationOperationKey, costBasis: 0,
      createdAt: '2026-09-06T00:00:00Z',
    } as UsageEvent;
    canonical.set(`${separationOperationKey}|completed`, completed);
  }

  const deps = {
    projects: {
      getByIdForUser: vi.fn(async () => project),
      setStatus: vi.fn(async () => {}),
      setExportObject: vi.fn(async () => {}),
    },
    jobs: {
      getForProject: vi.fn(async () => ({ status: 'running' as const, retryCount: 0 })),
      setProgress: vi.fn(async () => {}), fail: vi.fn(async () => {}), complete: vi.fn(async () => {}),
    },
    segments: {
      list: vi.fn(async () => sourceSegments),
      setVoiceResult: vi.fn(async () => {}),
    },
    translations: {
      list: vi.fn(async (_projectId: string, _userId: string, target: string) => target === 'ja' ? jaVariants : []),
      setVoiceResult: vi.fn(async () => {}),
    },
    exports: {
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      invalidateTarget: vi.fn(async () => {}),
      invalidateAll: vi.fn(async () => {}),
    },
    speakers: { list: vi.fn(async () => []) },
    stems: {
      latestCompleted: vi.fn(async () => reusableStem),
      begin: vi.fn(async () => pendingStem),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    },
    separation: {
      capabilities: vi.fn(async () => ({
        configured,
        provider,
        backgroundStem: qualification === 'qualified',
        dialogueStem: false,
        qualification,
      })),
      separate: vi.fn(async () => ({
        provider: provider ?? 'qualified-provider',
        providerVersion: 'v1',
        backgroundObjectKey: `projects/p1/stems/3/${provider ?? 'qualified-provider'}/background.wav`,
      })),
    },
    bucket: { put: vi.fn(async () => ({})) },
    voice: {
      generate: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })),
    },
    media: {
      probe: vi.fn(async (key: string) => ({ durationMs: key.includes('/voices/') || key.includes('/dubbed/') ? 1_500 : 10_000 })),
      renderExport: vi.fn(async (
        _projectId: string,
        _sourceObjectKey: string,
        _clips: unknown[],
        options?: { targetLanguage: string; exportId: string; audioMode?: string; backgroundObjectKey?: string },
      ) => ({
        exportObjectKey: options
          ? `projects/p1/exports/${options.targetLanguage}/${options.exportId}.mp4`
          : 'projects/p1/export/dubbed.mp4',
      })),
    },
    usage,
    telemetry: { write: vi.fn(async () => {}) },
  };
  return { deps, usageEvents, canonical, sourceSegments, jaVariants, project, separationOperationKey };
}

const jaDubbed = {
  projectId: 'p1', userId: 'dev-user', jobId: 'j-ja', exportId: 'export-ja-1', targetLanguage: 'ja', output: 'dubbed',
  audioMode: 'dubbed_only',
} as const;

describe('Phase 4C language-aware export workflow', () => {
  it('feeds JA target variants into JA TTS and publishes a language-scoped immutable MP4', async () => {
    const h = harness();
    await runExportPipeline(jaDubbed as never, h.deps as never, step() as never);

    expect(h.deps.translations.list).toHaveBeenCalledWith('p1', 'dev-user', 'ja');
    expect(h.deps.voice.generate).toHaveBeenCalledWith({ text: 'こんにちは', language: 'ja' });
    expect(h.deps.bucket.put).toHaveBeenCalledWith(
      'projects/p1/voices/ja/s1/3.mp3',
      expect.any(ArrayBuffer),
    );
    expect(h.deps.translations.setVoiceResult).toHaveBeenCalledWith(
      'p1', 's1', 'dev-user', 'ja', 'projects/p1/voices/ja/s1/3.mp3',
    );
    expect(h.deps.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/video.mp4',
      [{ segmentId: 's1', startMs: 0, endMs: 2_000, objectKey: 'projects/p1/voices/ja/s1/3.mp3' }],
      { targetLanguage: 'ja', exportId: 'export-ja-1', audioMode: 'dubbed_only' },
    );
    expect(h.deps.exports.complete).toHaveBeenCalledWith('p1', 'export-ja-1', 'dev-user', {
      exportObjectKey: 'projects/p1/exports/ja/export-ja-1.mp4',
    });
    expect(h.deps.projects.setExportObject).not.toHaveBeenCalled();
    expect(h.usageEvents.some((event) => event.operationKey.includes(':tts:ja:'))).toBe(true);
    expect(h.usageEvents.some((event) => event.operationKey.includes(':render:ja:'))).toBe(true);
  });

  it('writes deterministic target SRT and records no voice/render usage for subtitle output', async () => {
    const h = harness();
    await runExportPipeline({
      projectId: 'p1', userId: 'dev-user', jobId: 'j-sub', exportId: 'export-sub-1', targetLanguage: 'ja', output: 'subtitles',
      audioMode: 'dubbed_only',
    } as never, h.deps as never, step() as never);

    expect(h.deps.translations.list).toHaveBeenCalledWith('p1', 'dev-user', 'ja');
    expect(h.deps.bucket.put).toHaveBeenCalledWith(
      'projects/p1/subtitles/ja/export-sub-1.srt',
      expect.any(ArrayBuffer),
    );
    expect(h.deps.voice.generate).not.toHaveBeenCalled();
    expect(h.deps.media.renderExport).not.toHaveBeenCalled();
    expect(h.deps.separation.capabilities).not.toHaveBeenCalled();
    expect(h.usageEvents.some((event) => event.kind === 'tts_audio_second' || event.kind === 'render_second')).toBe(false);
    expect(h.deps.exports.complete).toHaveBeenCalledWith('p1', 'export-sub-1', 'dev-user', {
      subtitleObjectKey: 'projects/p1/subtitles/ja/export-sub-1.srt',
    });
  });

  it('reuses a completed JA voice artifact without new TTS usage on retry', async () => {
    const h = harness();
    h.jaVariants[0].voiceStatus = 'completed';
    h.jaVariants[0].dubbedObjectKey = 'projects/p1/voices/ja/s1/3.mp3';

    await runExportPipeline(jaDubbed as never, h.deps as never, step() as never);

    expect(h.deps.voice.generate).not.toHaveBeenCalled();
    expect(h.deps.bucket.put).not.toHaveBeenCalledWith('projects/p1/voices/ja/s1/3.mp3', expect.anything());
    expect(h.deps.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/video.mp4',
      [{ segmentId: 's1', startMs: 0, endMs: 2_000, objectKey: 'projects/p1/voices/ja/s1/3.mp3' }],
      { targetLanguage: 'ja', exportId: 'export-ja-1', audioMode: 'dubbed_only' },
    );
    expect(h.usageEvents.some((event) => event.kind === 'tts_audio_second')).toBe(false);
  });

  it('fails only the current JA export row without invalidating other language exports', async () => {
    const h = harness();
    h.deps.media.renderExport.mockRejectedValueOnce(new Error('JA render failed'));

    await expect(runExportPipeline(jaDubbed as never, h.deps as never, step() as never)).rejects.toThrow('JA render failed');

    expect(h.deps.exports.fail).toHaveBeenCalledWith(
      'p1', 'export-ja-1', 'dev-user', 'EXPORT_FAILED', 'JA render failed',
    );
    expect(h.deps.exports.complete).not.toHaveBeenCalled();
    expect(h.deps.exports.invalidateTarget).not.toHaveBeenCalled();
    expect(h.deps.exports.invalidateAll).not.toHaveBeenCalled();
  });
});

describe('Phase 4D hybrid audio export workflow', () => {
  it('passes duck_original through to render without touching separation provider or usage', async () => {
    const h = harness();
    await runExportPipeline({ ...jaDubbed, audioMode: 'duck_original' } as never, h.deps as never, step() as never);

    expect(h.deps.separation.capabilities).not.toHaveBeenCalled();
    expect(h.deps.separation.separate).not.toHaveBeenCalled();
    expect(h.deps.stems.latestCompleted).not.toHaveBeenCalled();
    expect(h.usageEvents.some((event) => event.kind === ('dialogue_separation_second' as never))).toBe(false);
    expect(h.deps.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/video.mp4',
      expect.any(Array),
      { targetLanguage: 'ja', exportId: 'export-ja-1', audioMode: 'duck_original' },
    );
  });

  it('creates and accounts for one qualified current-generation background stem before rendering', async () => {
    const h = harness();
    await runExportPipeline({ ...jaDubbed, audioMode: 'separated_background' } as never, h.deps as never, step() as never);

    expect(h.deps.separation.capabilities).toHaveBeenCalledTimes(1);
    expect(h.deps.stems.latestCompleted).toHaveBeenCalledWith('p1', 'dev-user', 3, 'background', 'qualified-provider');
    expect(h.deps.stems.begin).toHaveBeenCalledWith('p1', 'dev-user', 3, 'background', 'qualified-provider', null);
    expect(h.deps.separation.separate).toHaveBeenCalledWith({
      projectId: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4', sourceGeneration: 3, durationMs: 10_000,
    });
    expect(h.deps.stems.complete).toHaveBeenCalledWith(
      'p1', 'stem-pending-1', 'dev-user', 'projects/p1/stems/3/qualified-provider/background.wav', 'v1',
    );
    expect(h.usageEvents.filter((event) => event.kind === ('dialogue_separation_second' as never))).toEqual([
      expect.objectContaining({
        phase: 'started', units: 10, provider: 'qualified-provider', operationKey: h.separationOperationKey,
      }),
      expect.objectContaining({
        phase: 'completed', units: 10, provider: 'qualified-provider', operationKey: h.separationOperationKey,
      }),
    ]);
    expect(h.deps.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/video.mp4',
      expect.any(Array),
      {
        targetLanguage: 'ja', exportId: 'export-ja-1', audioMode: 'separated_background',
        backgroundObjectKey: 'projects/p1/stems/3/qualified-provider/background.wav',
      },
    );
  });

  it('reuses a completed valid current-generation background stem without provider or new separation usage', async () => {
    const reusableStem = {
      id: 'stem-existing', projectId: 'p1', sourceGeneration: 3, kind: 'background' as const,
      provider: 'qualified-provider', providerVersion: 'v1', status: 'completed' as const,
      objectKey: 'projects/p1/stems/3/qualified-provider/background.wav',
      errorCode: null, errorMessage: null,
      createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z',
    };
    const h = harness({ reusableStem });

    await runExportPipeline({ ...jaDubbed, audioMode: 'separated_background' } as never, h.deps as never, step() as never);

    expect(h.deps.separation.capabilities).toHaveBeenCalledTimes(1);
    expect(h.deps.separation.separate).not.toHaveBeenCalled();
    expect(h.deps.stems.begin).not.toHaveBeenCalled();
    expect(h.usageEvents.some((event) => event.kind === ('dialogue_separation_second' as never))).toBe(false);
    expect(h.deps.media.renderExport).toHaveBeenCalledWith(
      'p1', 'projects/p1/source/video.mp4', expect.any(Array),
      expect.objectContaining({
        audioMode: 'separated_background',
        backgroundObjectKey: 'projects/p1/stems/3/qualified-provider/background.wav',
      }),
    );
  });

  it('fails closed before TTS/provider work when separation is unavailable or unqualified', async () => {
    for (const qualification of ['unavailable', 'unqualified'] as const) {
      const h = harness({ separationQualification: qualification, separationConfigured: qualification !== 'unavailable' });
      await expect(runExportPipeline(
        { ...jaDubbed, audioMode: 'separated_background' } as never,
        h.deps as never,
        step() as never,
      )).rejects.toMatchObject({
        code: qualification === 'unqualified' ? 'DIALOGUE_SEPARATION_UNQUALIFIED' : 'DIALOGUE_SEPARATION_UNAVAILABLE',
      });
      expect(h.deps.separation.separate).not.toHaveBeenCalled();
      expect(h.deps.voice.generate).not.toHaveBeenCalled();
    }
  });

  it('does not repeat billable separation when completed accounting exists without a durable reusable stem', async () => {
    const h = harness({ completedSeparationAccounting: true });

    await expect(runExportPipeline(
      { ...jaDubbed, audioMode: 'separated_background' } as never,
      h.deps as never,
      step() as never,
    )).rejects.toMatchObject({ code: 'DIALOGUE_SEPARATION_ARTIFACT_INVALID' });

    expect(h.deps.separation.separate).not.toHaveBeenCalled();
    expect(h.deps.stems.begin).not.toHaveBeenCalled();
    expect(h.deps.voice.generate).not.toHaveBeenCalled();
  });
});
