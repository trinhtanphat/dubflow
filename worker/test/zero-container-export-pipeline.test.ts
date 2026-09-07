import { describe, expect, it, vi } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
}

describe('zero-container dubbed export pipeline', () => {
  it('generates PCM clips, streams one soundtrack, and publishes the exact MP4 through Stream', async () => {
    const usageEvents: UsageRecordInput[] = [];
    const project = {
      id: 'p1', userId: 'dev-user', title: 'Demo', sourceLanguage: 'zh' as const, targetLanguage: 'vi' as const,
      status: 'needs_review' as const, sourceObjectKey: 'projects/p1/source/video.mp4', durationMs: 10_000, sizeBytes: 123,
    };
    const segments = [{
      id: 's1', projectId: 'p1', speakerId: null, startMs: 1000, endMs: 2500,
      sourceText: '你好', translatedText: 'Xin chào', translationEngine: 'workers-ai', translationStatus: 'completed',
      voiceStatus: 'pending', dubbedObjectKey: null, version: 1, splitParentId: null,
    }];
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
        list: vi.fn(async () => segments),
        setVoiceResult: vi.fn(async () => {}),
      },
      bucket: {
        put: vi.fn(async (key: string, value: ArrayBuffer) => ({ key, size: value.byteLength })),
      },
      voice: {
        generate: vi.fn(async () => new Response(new Uint8Array([1, 0, 2, 0]), {
          headers: { 'content-type': 'application/octet-stream' },
        })),
      },
      soundtrack: {
        durationSeconds: vi.fn(async () => 1.5),
        storeSoundtrack: vi.fn(async () => 'projects/p1/soundtracks/vi/legacy.wav'),
      },
      publisher: {
        publishDubbedExport: vi.fn(async () => ({
          exportObjectKey: 'projects/p1/export/dubbed.mp4', audioTrackUid: 'audio-1',
        })),
      },
      usage: {
        record: vi.fn(async (input: UsageRecordInput) => { usageEvents.push(input); return input as never; }),
        getByOperation: vi.fn(async () => null),
      },
      telemetry: { write: vi.fn(async () => {}) },
    };

    const result = await runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1' },
      deps as never,
      step() as never,
    );

    expect(deps.voice.generate).toHaveBeenCalledWith({
      text: 'Xin chào', language: 'vi', outputFormat: 'pcm_24000',
    });
    expect(deps.bucket.put).toHaveBeenCalledWith('projects/p1/dubbed/s1.pcm', expect.any(ArrayBuffer));
    expect(deps.segments.setVoiceResult).toHaveBeenCalledWith('p1', 's1', 'dev-user', 'projects/p1/dubbed/s1.pcm');
    expect(deps.soundtrack.durationSeconds).toHaveBeenCalledWith('projects/p1/dubbed/s1.pcm');
    expect(deps.soundtrack.storeSoundtrack).toHaveBeenCalledWith({
      projectId: 'p1', targetLanguage: 'vi', exportId: 'legacy', durationMs: 10_000,
      clips: [{ startMs: 1000, endMs: 2500, objectKey: 'projects/p1/dubbed/s1.pcm' }],
    });
    expect(deps.publisher.publishDubbedExport).toHaveBeenCalledWith({
      projectId: 'p1', userId: 'dev-user', sourceObjectKey: 'projects/p1/source/video.mp4',
      soundtrackObjectKey: 'projects/p1/soundtracks/vi/legacy.wav', targetLanguage: 'vi', exportId: 'legacy',
      exportObjectKey: 'projects/p1/export/dubbed.mp4',
    });
    expect(usageEvents.filter((event) => event.kind === 'render_second')).toEqual([
      expect.objectContaining({ units: 10, provider: 'cloudflare-stream', phase: 'started', operationKey: 'job:j1:retry:0:render:final:cloudflare-stream' }),
      expect.objectContaining({ units: 10, provider: 'cloudflare-stream', phase: 'completed', operationKey: 'job:j1:retry:0:render:final:cloudflare-stream' }),
    ]);
    expect(deps.projects.setExportObject).toHaveBeenCalledWith('p1', 'dev-user', 'projects/p1/export/dubbed.mp4');
    expect(deps.jobs.complete).toHaveBeenCalledWith('j1');
    expect(result).toEqual({ status: 'completed', exportObjectKey: 'projects/p1/export/dubbed.mp4' });
  });
});
