import { describe, expect, it, vi } from 'vitest';
import { JobCancelledError } from '../src/workflows/jobCancellation';
import { runVisualLipSync } from '../src/workflows/visualLipSync';

describe('visual lip-sync cancellation boundary', () => {
  it('rethrows JOB_CANCELLED unchanged before provider work instead of converting it to a visual provider failure', async () => {
    const cancelled = new JobCancelledError();
    const grants = { create: vi.fn(), expire: vi.fn() };
    const provider = { id: 'sync-labs', available: true, render: vi.fn() };
    const deps = {
      exports: {
        get: vi.fn(async () => null),
        setLipSyncState: vi.fn(async () => {}),
      },
      providerMediaGrants: grants,
      lipSync: provider,
      bucket: { put: vi.fn() },
      usage: {
        getByOperation: vi.fn(async () => null),
        record: vi.fn(),
      },
      telemetry: { write: vi.fn(async () => {}) },
    };
    const step = { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
    const ensureActive = vi.fn(async () => { throw cancelled; });

    await expect(runVisualLipSync({
      projectId: 'p1',
      userId: 'u1',
      jobId: 'j1',
      retryCount: 0,
      targetLanguage: 'vi',
      exportId: 'e1',
      standardObjectKey: 'projects/p1/exports/vi/e1.mp4',
      soundtrackObjectKey: 'projects/p1/soundtracks/vi/e1.wav',
      durationMs: 5_000,
    }, deps as never, step as never, ensureActive)).rejects.toBe(cancelled);

    expect(provider.render).not.toHaveBeenCalled();
    expect(grants.create).not.toHaveBeenCalled();
  });
});
