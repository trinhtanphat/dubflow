import { describe, expect, it, vi } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

describe('Phase 4D separation retry safety', () => {
  it('retries a failed provider attempt from a new export job without colliding on project-scoped started usage', async () => {
    const usage = new Map<string, UsageRecordInput>();
    let stemSerial = 0;
    let stem: {
      id: string;
      status: 'pending' | 'completed' | 'failed';
      objectKey: string | null;
    } | null = null;
    const expectedBackground = 'projects/p1/stems/1/separator/background.wav';

    const separation = {
      capabilities: vi.fn(async () => ({
        configured: true,
        provider: 'separator',
        backgroundStem: true,
        dialogueStem: false,
        qualification: 'qualified' as const,
      })),
      separate: vi.fn()
        .mockRejectedValueOnce(new Error('provider failed'))
        .mockResolvedValueOnce({
          provider: 'separator',
          providerVersion: '1',
          backgroundObjectKey: expectedBackground,
        }),
    };

    const deps = {
      projects: {
        getByIdForUser: vi.fn(async () => ({
          id: 'p1',
          sourceObjectKey: 'projects/p1/source/video.mp4',
          durationMs: 10_000,
          sourceGeneration: 1,
        })),
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
        list: vi.fn(async () => [{
          id: 's1',
          speakerId: null,
          startMs: 0,
          endMs: 2_000,
          translatedText: 'legacy',
          voiceStatus: 'completed',
          dubbedObjectKey: null,
          version: 1,
        }]),
        setVoiceResult: vi.fn(async () => {}),
      },
      translations: {
        list: vi.fn(async () => [{
          segmentId: 's1',
          targetLanguage: 'ja' as const,
          translatedText: 'こんにちは',
          translationStatus: 'completed',
          voiceStatus: 'completed',
          dubbedObjectKey: 'projects/p1/voices/ja/s1/1.mp3',
          version: 1,
        }]),
        setVoiceResult: vi.fn(async () => {}),
      },
      exports: {
        complete: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
      },
      speakers: { list: vi.fn(async () => []) },
      stems: {
        latestCompleted: vi.fn(async () => stem?.status === 'completed' ? {
          id: stem.id,
          projectId: 'p1',
          sourceGeneration: 1,
          kind: 'background' as const,
          provider: 'separator',
          providerVersion: '1',
          status: 'completed' as const,
          objectKey: stem.objectKey,
          errorCode: null,
          errorMessage: null,
          createdAt: '',
          updatedAt: '',
        } : null),
        begin: vi.fn(async () => {
          if (stem?.status === 'pending' || stem?.status === 'completed') return {
            id: stem.id,
            projectId: 'p1',
            sourceGeneration: 1,
            kind: 'background' as const,
            provider: 'separator',
            providerVersion: null,
            status: stem.status,
            objectKey: stem.objectKey,
            errorCode: null,
            errorMessage: null,
            createdAt: '',
            updatedAt: '',
          };
          stem = { id: `stem-${++stemSerial}`, status: 'pending', objectKey: null };
          return {
            id: stem.id,
            projectId: 'p1',
            sourceGeneration: 1,
            kind: 'background' as const,
            provider: 'separator',
            providerVersion: null,
            status: 'pending' as const,
            objectKey: null,
            errorCode: null,
            errorMessage: null,
            createdAt: '',
            updatedAt: '',
          };
        }),
        complete: vi.fn(async (_projectId: string, stemId: string, _userId: string, objectKey: string) => {
          expect(stem?.id).toBe(stemId);
          stem = { id: stemId, status: 'completed', objectKey };
        }),
        fail: vi.fn(async (_projectId: string, stemId: string) => {
          expect(stem?.id).toBe(stemId);
          stem = { id: stemId, status: 'failed', objectKey: null };
        }),
      },
      separation,
      bucket: { put: vi.fn(async () => ({})) },
      voice: { generate: vi.fn(async () => { throw new Error('voice must not run'); }) },
      media: {
        probe: vi.fn(async () => ({ durationMs: 1_000 })),
        renderExport: vi.fn(async (_projectId: string, _source: string, _clips: unknown[], options: { targetLanguage: string; exportId: string }) => ({
          exportObjectKey: `projects/p1/exports/${options.targetLanguage}/${options.exportId}.mp4`,
        })),
      },
      usage: {
        getByOperation: vi.fn(async (operationKey: string, phase: 'started' | 'completed') => usage.get(`${operationKey}|${phase}`) ?? null),
        record: vi.fn(async (input: UsageRecordInput) => {
          const key = `${input.operationKey}|${input.phase}`;
          const existing = usage.get(key);
          if (existing) {
            if (existing.jobId !== input.jobId) throw new Error('usage operation key collision detected');
            return { ...existing, id: key, costBasis: 0, createdAt: '' };
          }
          usage.set(key, input);
          return { ...input, id: key, costBasis: 0, createdAt: '' };
        }),
      },
      telemetry: { write: vi.fn(async () => {}) },
    };

    await expect(runExportPipeline({
      projectId: 'p1',
      userId: 'u1',
      jobId: 'job-1',
      exportId: 'export-1',
      targetLanguage: 'ja',
      output: 'dubbed',
      audioMode: 'separated_background',
    }, deps as never, step() as never)).rejects.toMatchObject({ code: 'DIALOGUE_SEPARATION_FAILED' });

    expect(stem).toMatchObject({ status: 'failed' });

    await expect(runExportPipeline({
      projectId: 'p1',
      userId: 'u1',
      jobId: 'job-2',
      exportId: 'export-2',
      targetLanguage: 'ja',
      output: 'dubbed',
      audioMode: 'separated_background',
    }, deps as never, step() as never)).resolves.toEqual({
      status: 'completed',
      exportObjectKey: 'projects/p1/exports/ja/export-2.mp4',
    });

    expect(separation.separate).toHaveBeenCalledTimes(2);
    expect(stem).toMatchObject({ status: 'completed', objectKey: expectedBackground });
  });
});
