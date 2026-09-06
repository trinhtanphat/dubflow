import { describe, expect, it, vi } from 'vitest';
import type { UsageEvent, UsagePhase, UsageRecordInput } from '../src/db/usage';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

function harness() {
  const usageEvents: UsageRecordInput[] = [];
  const canonical = new Map<string, UsageEvent>();
  const project = {
    id: 'p1', userId: 'dev-user', sourceObjectKey: 'projects/p1/source/video.mp4', durationMs: 10_000,
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
        options?: { targetLanguage: string; exportId: string },
      ) => ({
        exportObjectKey: options
          ? `projects/p1/exports/${options.targetLanguage}/${options.exportId}.mp4`
          : 'projects/p1/export/dubbed.mp4',
      })),
    },
    usage,
    telemetry: { write: vi.fn(async () => {}) },
  };
  return { deps, usageEvents, sourceSegments, jaVariants };
}

const jaDubbed = {
  projectId: 'p1', userId: 'dev-user', jobId: 'j-ja', exportId: 'export-ja-1', targetLanguage: 'ja', output: 'dubbed',
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
      { targetLanguage: 'ja', exportId: 'export-ja-1' },
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
    } as never, h.deps as never, step() as never);

    expect(h.deps.translations.list).toHaveBeenCalledWith('p1', 'dev-user', 'ja');
    expect(h.deps.bucket.put).toHaveBeenCalledWith(
      'projects/p1/subtitles/ja/export-sub-1.srt',
      expect.any(ArrayBuffer),
    );
    expect(h.deps.voice.generate).not.toHaveBeenCalled();
    expect(h.deps.media.renderExport).not.toHaveBeenCalled();
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
      { targetLanguage: 'ja', exportId: 'export-ja-1' },
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
