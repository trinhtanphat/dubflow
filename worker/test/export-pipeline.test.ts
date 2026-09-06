import { describe, expect, it, vi } from 'vitest';
import type { UsageEvent, UsagePhase, UsageRecordInput } from '../src/db/usage';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

function deps() {
  const project = {
    id: 'p1', userId: 'dev-user', title: 'Demo', sourceLanguage: 'zh' as const, targetLanguage: 'vi' as const,
    status: 'needs_review' as const, sourceObjectKey: 'projects/p1/source/video.mp4', durationMs: 10000, sizeBytes: 123,
  };
  const segments = [
    {
      id: 's1', projectId: 'p1', speakerId: null, startMs: 1000, endMs: 2500,
      sourceText: '你好', translatedText: 'Xin chào', translationEngine: 'workers-ai', translationStatus: 'completed',
      voiceStatus: 'pending', dubbedObjectKey: null, version: 1, splitParentId: null,
    },
    {
      id: 's2', projectId: 'p1', speakerId: null, startMs: 3000, endMs: 5000,
      sourceText: '再见', translatedText: 'Tạm biệt', translationEngine: 'workers-ai', translationStatus: 'completed',
      voiceStatus: 'completed', dubbedObjectKey: 'projects/p1/dubbed/s2.mp3', version: 1, splitParentId: null,
    },
  ];
  const usageEvents: UsageRecordInput[] = [];
  const canonical = new Map<string, UsageEvent>();
  const usage = {
    record: vi.fn(async (input: UsageRecordInput) => {
      usageEvents.push(input);
      const key = `${input.operationKey}|${input.phase}`;
      const event = {
        ...input,
        id: `usage-${canonical.size + 1}`,
        costBasis: 0,
        createdAt: '2026-09-05T00:00:00Z',
      } satisfies UsageEvent;
      if (!canonical.has(key)) canonical.set(key, event);
      return canonical.get(key)!;
    }),
    getByOperation: vi.fn(async (operationKey: string, phase: UsagePhase) => canonical.get(`${operationKey}|${phase}`) ?? null),
  };
  return {
    project,
    segmentsData: segments,
    usageEvents,
    canonical,
    projects: {
      getByIdForUser: vi.fn(async () => project),
      setStatus: vi.fn(async () => {}),
      setExportObject: vi.fn(async () => {}),
    },
    jobs: {
      getForProject: vi.fn(async (): Promise<{ status: 'running' | 'cancelled'; retryCount: number }> => ({ status: 'running', retryCount: 0 })),
      setProgress: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    },
    segments: {
      list: vi.fn(async () => segments),
      setVoiceResult: vi.fn(async () => {}),
    },
    bucket: {
      put: vi.fn(async (key: string, value: ArrayBuffer) => ({ key, size: value.byteLength })),
    },
    voice: {
      generate: vi.fn(async ({ text }: { text: string }) => new Response(new TextEncoder().encode(`audio:${text}`), {
        headers: { 'content-type': 'audio/mpeg' },
      })),
    },
    media: {
      probe: vi.fn(async (key: string) => ({ durationMs: key.includes('/dubbed/') ? 2250 : 10000 })),
      renderExport: vi.fn(async () => ({ exportObjectKey: 'projects/p1/export/dubbed.mp4' })),
    },
    usage,
  };
}

describe('final dubbing export pipeline', () => {
  it('meters newly generated TTS by probed audio seconds and final render by durable project seconds', async () => {
    const d = deps();
    const result = await runExportPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, d as any, step() as any);

    expect(d.voice.generate).toHaveBeenCalledTimes(1);
    expect(d.voice.generate).toHaveBeenCalledWith({ text: 'Xin chào', language: 'vi' });
    expect(d.bucket.put).toHaveBeenCalledWith('projects/p1/dubbed/s1.mp3', expect.any(ArrayBuffer));
    expect(d.segments.setVoiceResult).toHaveBeenCalledWith('p1', 's1', 'dev-user', 'projects/p1/dubbed/s1.mp3');
    expect(d.media.probe).toHaveBeenCalledWith('projects/p1/dubbed/s1.mp3');

    const tts = d.usageEvents.filter((event) => event.kind === 'tts_audio_second');
    expect(tts).toEqual([
      expect.objectContaining({ units: 0, provider: 'elevenlabs', phase: 'started', operationKey: 'job:j1:retry:0:tts:s1:elevenlabs' }),
      expect.objectContaining({ units: 2.25, provider: 'elevenlabs', phase: 'completed', operationKey: 'job:j1:retry:0:tts:s1:elevenlabs' }),
    ]);
    expect(d.usageEvents.some((event) => event.operationKey.includes(':tts:s2:'))).toBe(false);

    const render = d.usageEvents.filter((event) => event.kind === 'render_second');
    expect(render).toHaveLength(2);
    expect(render[0]).toMatchObject({ units: 10, provider: 'ffmpeg-container', phase: 'started', operationKey: 'job:j1:retry:0:render:final:ffmpeg-container' });
    expect(render[1]).toMatchObject({ units: 10, provider: 'ffmpeg-container', phase: 'completed', operationKey: 'job:j1:retry:0:render:final:ffmpeg-container' });

    expect(d.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/video.mp4',
      [
        { segmentId: 's1', startMs: 1000, endMs: 2500, objectKey: 'projects/p1/dubbed/s1.mp3' },
        { segmentId: 's2', startMs: 3000, endMs: 5000, objectKey: 'projects/p1/dubbed/s2.mp3' },
      ],
    );
    expect(d.projects.setExportObject).toHaveBeenCalledWith('p1', 'dev-user', 'projects/p1/export/dubbed.mp4');
    expect(d.projects.setStatus).toHaveBeenLastCalledWith('p1', 'dev-user', 'completed');
    expect(d.jobs.complete).toHaveBeenCalledWith('j1');
    expect(result).toEqual({ status: 'completed', exportObjectKey: 'projects/p1/export/dubbed.mp4' });
  });

  it('recovers current-generation TTS metering from a durable artifact without regenerating voice', async () => {
    const d = deps();
    d.segmentsData[0].voiceStatus = 'completed';
    d.segmentsData[0].dubbedObjectKey = 'projects/p1/dubbed/s1.mp3';
    await d.usage.record({
      userId: 'dev-user', projectId: 'p1', jobId: 'j1', kind: 'tts_audio_second', units: 0,
      provider: 'elevenlabs', phase: 'started', operationKey: 'job:j1:retry:0:tts:s1:elevenlabs',
    });
    d.usageEvents.length = 0;

    await runExportPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, d as any, step() as any);

    expect(d.voice.generate).not.toHaveBeenCalled();
    expect(d.bucket.put).not.toHaveBeenCalled();
    expect(d.media.probe).toHaveBeenCalledWith('projects/p1/dubbed/s1.mp3');
    expect(d.usageEvents).toContainEqual(expect.objectContaining({
      kind: 'tts_audio_second', units: 2.25, provider: 'elevenlabs', phase: 'completed',
      operationKey: 'job:j1:retry:0:tts:s1:elevenlabs',
    }));
    expect(d.usageEvents.some((event) => event.operationKey.includes(':tts:s2:'))).toBe(false);
  });

  it('does not meter a pre-existing durable TTS artifact from before the current retry generation', async () => {
    const d = deps();
    d.segmentsData[0].voiceStatus = 'completed';
    d.segmentsData[0].dubbedObjectKey = 'projects/p1/dubbed/s1.mp3';

    await runExportPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, d as any, step() as any);

    expect(d.voice.generate).not.toHaveBeenCalled();
    expect(d.usageEvents.some((event) => event.kind === 'tts_audio_second')).toBe(false);
    expect(d.media.probe).not.toHaveBeenCalledWith('projects/p1/dubbed/s1.mp3');
  });

  it('fails closed before rendering when a translated segment is empty', async () => {
    const d = deps();
    (d.segments.list as any).mockResolvedValue([{ ...(await d.segments.list())[0], translatedText: '   ' }]);
    await expect(runExportPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, d as any, step() as any))
      .rejects.toThrow(/translated text/i);
    expect(d.media.renderExport).not.toHaveBeenCalled();
    expect(d.jobs.fail).toHaveBeenCalledWith('j1', 'EXPORT_FAILED', expect.any(String));
    expect(d.projects.setStatus).toHaveBeenLastCalledWith('p1', 'dev-user', 'needs_review');
  });

  it('stops before voice generation when the durable export job is cancelled', async () => {
    const d = deps();
    let checks = 0;
    d.jobs.getForProject.mockImplementation(async () => {
      checks += 1;
      return { status: checks >= 3 ? 'cancelled' : 'running', retryCount: 0 };
    });

    await expect(runExportPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, d as any, step() as any))
      .rejects.toMatchObject({ code: 'JOB_CANCELLED' });
    expect(d.voice.generate).not.toHaveBeenCalled();
    expect(d.media.renderExport).not.toHaveBeenCalled();
    expect(d.jobs.fail).not.toHaveBeenCalled();
    expect(d.projects.setStatus).toHaveBeenLastCalledWith('p1', 'dev-user', 'cancelled');
  });
});

function phase4dDeps(stemsPresent = false) {
  const d = deps();
  d.project.sourceObjectKey = 'projects/p1/source/source_rev.mp4';
  d.media.renderExport.mockResolvedValue({ exportObjectKey: 'projects/p1/exports/vi/export-1.mp4' });

  const variants = d.segmentsData.map((segment) => ({
    segmentId: segment.id,
    projectId: 'p1',
    targetLanguage: 'vi' as const,
    translatedText: segment.translatedText,
    translationStatus: 'completed',
    translationContextRevision: 1,
    voiceStatus: 'completed',
    dubbedObjectKey: `projects/p1/voices/vi/${segment.id}/1.mp3`,
    version: 1,
  }));
  const stemKeys = {
    dialogueObjectKey: 'projects/p1/stems/source_rev/dialogue.wav',
    backgroundObjectKey: 'projects/p1/stems/source_rev/background.wav',
  };
  const durable = new Set<string>(stemsPresent ? Object.values(stemKeys) : []);
  const separate = vi.fn(async () => {
    durable.add(stemKeys.dialogueObjectKey);
    durable.add(stemKeys.backgroundObjectKey);
    return stemKeys;
  });
  const head = vi.fn(async (key: string) => durable.has(key) ? { key, size: 1 } : null);
  const exportsStore = {
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  };

  return {
    ...d,
    translations: {
      list: vi.fn(async () => variants),
      setVoiceResult: vi.fn(async () => {}),
    },
    exports: exportsStore,
    bucket: {
      ...d.bucket,
      head,
    },
    separation: {
      id: 'elevenlabs-stems-v1',
      available: true,
      separate,
    },
    separate,
    head,
    stemKeys,
    durable,
  };
}

function phase4dParams(separationMode: 'source_mix' | 'preserve_background') {
  return {
    projectId: 'p1',
    userId: 'dev-user',
    jobId: 'j1',
    exportId: 'export-1',
    targetLanguage: 'vi' as const,
    output: 'dubbed' as const,
    separationMode,
  };
}

const stemOperationKey = 'job:j1:retry:0:stem-separation:source_rev:elevenlabs-stems-v1';

describe('Phase 4D idempotent dialogue/background separation', () => {
  it('keeps source_mix free of stem-provider work', async () => {
    const d = phase4dDeps(false);
    await runExportPipeline(phase4dParams('source_mix') as any, d as any, step() as any);

    expect(d.separate).not.toHaveBeenCalled();
    expect(d.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/source_rev.mp4',
      expect.any(Array),
      { targetLanguage: 'vi', exportId: 'export-1' },
    );
  });

  it('separates preserve_background once, meters source seconds, and passes the background stem into render', async () => {
    const d = phase4dDeps(false);
    await runExportPipeline(phase4dParams('preserve_background') as any, d as any, step() as any);

    expect(d.separate).toHaveBeenCalledTimes(1);
    expect(d.separate).toHaveBeenCalledWith({
      projectId: 'p1',
      sourceObjectKey: 'projects/p1/source/source_rev.mp4',
      sourceRevision: 'source_rev',
    });
    const separationUsage = d.usageEvents.filter((event) => String(event.kind) === 'stem_separation_audio_second');
    expect(separationUsage).toEqual([
      expect.objectContaining({ units: 0, phase: 'started', provider: 'elevenlabs-stems-v1', operationKey: stemOperationKey }),
      expect.objectContaining({ units: 10, phase: 'completed', provider: 'elevenlabs-stems-v1', operationKey: stemOperationKey }),
    ]);
    expect(d.media.probe).toHaveBeenCalledWith('projects/p1/source/source_rev.mp4');
    expect(d.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/source_rev.mp4',
      expect.any(Array),
      expect.objectContaining({
        targetLanguage: 'vi',
        exportId: 'export-1',
        backgroundObjectKey: d.stemKeys.backgroundObjectKey,
      }),
    );
  });

  it('reuses a durable canonical stem pair without duplicate provider work or usage', async () => {
    const d = phase4dDeps(true);
    await runExportPipeline(phase4dParams('preserve_background') as any, d as any, step() as any);

    expect(d.separate).not.toHaveBeenCalled();
    expect(d.usageEvents.some((event) => String(event.kind) === 'stem_separation_audio_second')).toBe(false);
    expect(d.media.renderExport).toHaveBeenCalledWith(
      'p1',
      'projects/p1/source/source_rev.mp4',
      expect.any(Array),
      expect.objectContaining({ backgroundObjectKey: d.stemKeys.backgroundObjectKey }),
    );
  });

  it('recovers a started separation usage event from a durable stem pair', async () => {
    const d = phase4dDeps(true);
    await d.usage.record({
      userId: 'dev-user', projectId: 'p1', jobId: 'j1', kind: 'stem_separation_audio_second' as any,
      units: 0, provider: 'elevenlabs-stems-v1', phase: 'started', operationKey: stemOperationKey,
    });
    d.usageEvents.length = 0;

    await runExportPipeline(phase4dParams('preserve_background') as any, d as any, step() as any);

    expect(d.separate).not.toHaveBeenCalled();
    expect(d.usageEvents).toContainEqual(expect.objectContaining({
      kind: 'stem_separation_audio_second',
      units: 10,
      provider: 'elevenlabs-stems-v1',
      phase: 'completed',
      operationKey: stemOperationKey,
    }));
  });

  it('fails closed when usage is completed but the durable canonical stem pair is missing', async () => {
    const d = phase4dDeps(false);
    await d.usage.record({
      userId: 'dev-user', projectId: 'p1', jobId: 'j1', kind: 'stem_separation_audio_second' as any,
      units: 10, provider: 'elevenlabs-stems-v1', phase: 'completed', operationKey: stemOperationKey,
    });
    d.usageEvents.length = 0;

    await expect(runExportPipeline(phase4dParams('preserve_background') as any, d as any, step() as any))
      .rejects.toThrow(/completed stem separation usage without a durable stem pair/i);
    expect(d.separate).not.toHaveBeenCalled();
    expect(d.media.renderExport).not.toHaveBeenCalled();
  });
});
