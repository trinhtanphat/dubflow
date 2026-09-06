import { describe, expect, it, vi } from 'vitest';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

describe('Phase 4C target export pipeline', () => {
  it('persists a cancelled export variant when the durable target job is cancelled', async () => {
    const cancelExport = vi.fn(async () => {});
    const failExport = vi.fn(async () => {});
    const setStatus = vi.fn(async () => {});
    const deps = {
      projects: {
        getByIdForUser: vi.fn(async () => ({
          id: 'p1',
          sourceObjectKey: 'projects/p1/source/video.mp4',
          sourceLanguage: 'zh' as const,
          durationMs: 10000,
        })),
        setStatus,
        setExportObject: vi.fn(async () => {}),
      },
      jobs: {
        getForProject: vi.fn(async () => ({ status: 'cancelled' as const, retryCount: 0 })),
        setProgress: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
        complete: vi.fn(async () => {}),
      },
      segments: {
        list: vi.fn(async () => []),
        setVoiceResult: vi.fn(async () => {}),
      },
      bucket: {},
      voice: { generate: vi.fn() },
      media: { probe: vi.fn(), renderExport: vi.fn() },
      usage: { record: vi.fn(), getByOperation: vi.fn() },
      telemetry: { emit: vi.fn() },
      multilang: {
        cancelExport,
        failExport,
        listBatchExports: vi.fn(async () => [{
          id: 'e1', projectId: 'p1', batchId: 'b1', targetLanguage: 'ja', status: 'cancelled',
          objectKey: null, jobId: 'j1', errorCode: 'EXPORT_CANCELLED', generation: 0,
        }]),
      },
    };

    await expect(runExportPipeline({
      projectId: 'p1',
      userId: 'dev-user',
      jobId: 'j1',
      exportId: 'e1',
      batchId: 'b1',
      targetLanguage: 'ja',
    }, deps as any, step() as any)).rejects.toMatchObject({ code: 'JOB_CANCELLED' });

    expect(cancelExport).toHaveBeenCalledWith('p1', 'e1', 'dev-user', 'EXPORT_CANCELLED');
    expect(failExport).not.toHaveBeenCalled();
    expect(deps.jobs.fail).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith('p1', 'dev-user', 'needs_review');
  });
});
