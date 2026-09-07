import { describe, expect, it, vi } from 'vitest';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

describe('legacy export lifecycle recovery', () => {
  it('repairs project processing state even when durable job failure recording also fails', async () => {
    const setStatus = vi.fn(async () => {});
    const jobsFail = vi.fn(async () => { throw new Error('job failure persistence unavailable'); });
    const deps = {
      projects: {
        getByIdForUser: vi.fn(async () => ({
          id: 'p1',
          sourceObjectKey: 'projects/p1/source/video.mp4',
          durationMs: 10_000,
          sourceGeneration: 1,
        })),
        setStatus,
        setExportObject: vi.fn(async () => {}),
      },
      jobs: {
        getForProject: vi.fn(async () => ({ status: 'running' as const, retryCount: 0 })),
        setProgress: vi.fn(async () => {}),
        fail: jobsFail,
        complete: vi.fn(async () => {}),
      },
      segments: {
        list: vi.fn(async () => [{
          id: 's1',
          speakerId: null,
          startMs: 0,
          endMs: 1_000,
          translatedText: 'Xin chào',
          voiceStatus: 'pending',
          dubbedObjectKey: null,
          version: 1,
        }]),
        setVoiceResult: vi.fn(async () => {}),
      },
      bucket: { put: vi.fn(async () => ({})) },
      voice: {
        generate: vi.fn(async () => { throw new Error('voice provider exploded'); }),
      },
      media: {
        probe: vi.fn(async () => ({ durationMs: 1_000 })),
        renderExport: vi.fn(async () => ({ exportObjectKey: 'projects/p1/export/dubbed.mp4' })),
      },
      usage: {
        getByOperation: vi.fn(async () => null),
        record: vi.fn(async () => ({})),
      },
      telemetry: { write: vi.fn() },
    };

    await expect(runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1' },
      deps as any,
      step() as any,
    )).rejects.toThrow('voice provider exploded');

    expect(jobsFail).toHaveBeenCalledWith('j1', 'EXPORT_FAILED', 'voice provider exploded');
    expect(setStatus).toHaveBeenCalledWith('p1', 'dev-user', 'processing');
    expect(setStatus).toHaveBeenLastCalledWith('p1', 'dev-user', 'needs_review');
  });
});
