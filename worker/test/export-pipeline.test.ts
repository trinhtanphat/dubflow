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
  it('meters newly generated TTS by probed audio seconds and final render by durable project minutes', async () => {
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

    const render = d.usageEvents.filter((event) => event.kind === 'render_minute');
    expect(render).toHaveLength(2);
    expect(render[0]).toMatchObject({ provider: 'ffmpeg-container', phase: 'started', operationKey: 'job:j1:retry:0:render:final:ffmpeg-container' });
    expect(render[0].units).toBeCloseTo(1 / 6, 10);
    expect(render[1]).toMatchObject({ provider: 'ffmpeg-container', phase: 'completed', operationKey: 'job:j1:retry:0:render:final:ffmpeg-container' });
    expect(render[1].units).toBeCloseTo(1 / 6, 10);

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
