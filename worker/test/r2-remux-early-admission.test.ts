import { describe, expect, it, vi } from 'vitest';
import { runZeroContainerExportPipeline } from '../src/workflows/zeroContainerExportPipeline';

function step() {
  return { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
}

describe('R2 remux early export admission', () => {
  it('rejects unsupported source video before TTS, soundtrack assembly, or publish work', async () => {
    const voiceGenerate = vi.fn(async () => {
      throw new Error('VOICE_SHOULD_NOT_RUN');
    });
    const soundtrackStore = vi.fn(async () => 'projects/p1/soundtracks/vi/legacy.wav');
    const publish = vi.fn(async () => ({
      exportObjectKey: 'projects/p1/export/dubbed.mp4',
      audioTrackUid: 'r2-aac',
    }));
    const inspect = vi.fn(async () => {
      throw new Error('VIDEO_TRANSCODE_REQUIRED: source codec vp9 is not packet-copy compatible');
    });

    const deps = {
      projects: {
        getByIdForUser: vi.fn(async () => ({
          id: 'p1',
          sourceObjectKey: 'projects/p1/source/video.webm',
          durationMs: 10_000,
        })),
        setStatus: vi.fn(async () => {}),
        setExportObject: vi.fn(async () => {}),
      },
      jobs: {
        getForProject: vi.fn(async () => ({ status: 'running', retryCount: 0 })),
        setProgress: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
        complete: vi.fn(async () => {}),
      },
      segments: {
        list: vi.fn(async () => [{
          id: 's1', speakerId: null, startMs: 0, endMs: 1000,
          translatedText: 'Xin chào', voiceStatus: 'pending', dubbedObjectKey: null, version: 1,
        }]),
        setVoiceResult: vi.fn(async () => {}),
      },
      bucket: { put: vi.fn(async () => ({ key: 'unused', size: 0 })) },
      voice: { generate: voiceGenerate },
      soundtrack: {
        durationSeconds: vi.fn(async () => 1),
        storeSoundtrack: soundtrackStore,
      },
      publisher: { inspect, publishDubbedExport: publish },
      usage: {
        record: vi.fn(async (input) => input),
        getByOperation: vi.fn(async () => null),
      },
      telemetry: { write: vi.fn(async () => {}) },
    };

    await expect(runZeroContainerExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1' },
      deps as never,
      step() as never,
    )).rejects.toThrow(/VIDEO_TRANSCODE_REQUIRED/);

    expect(inspect).toHaveBeenCalledWith('projects/p1/source/video.webm');
    expect(voiceGenerate).not.toHaveBeenCalled();
    expect(soundtrackStore).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
