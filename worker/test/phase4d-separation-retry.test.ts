import { describe, expect, it, vi } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runSeparationPipeline } from '../src/workflows/separationPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

describe('Phase 4D separation retry safety', () => {
  it('retries a failed provider attempt with a new retry generation without usage-key collision', async () => {
    const usage = new Map<string, UsageRecordInput>();
    const stems = new Map<'background' | 'dialogue', {
      id: string;
      status: 'pending' | 'completed' | 'failed';
      objectKey: string | null;
    }>();
    let stemSerial = 0;
    let retryCount = 0;
    const provider = 'separator';
    const expectedBackground = 'projects/p1/stems/1/separator/background.wav';
    const expectedDialogue = 'projects/p1/stems/1/separator/dialogue.wav';

    const separation = {
      capabilities: vi.fn(async () => ({
        configured: true,
        provider,
        backgroundStem: true,
        dialogueStem: true,
        qualification: 'qualified' as const,
      })),
      separate: vi.fn()
        .mockRejectedValueOnce(new Error('provider failed'))
        .mockResolvedValueOnce({
          provider,
          providerVersion: '1',
          backgroundObjectKey: expectedBackground,
          dialogueObjectKey: expectedDialogue,
        }),
    };

    const deps = {
      projects: {
        getByIdForUser: vi.fn(async () => ({
          id: 'p1',
          userId: 'u1',
          title: 'P1',
          sourceLanguage: 'zh' as const,
          targetLanguage: 'vi' as const,
          targetLanguagesRevision: 1,
          sourceGeneration: 1,
          status: 'needs_review' as const,
          sourceObjectKey: 'projects/p1/source/video.mp4',
          durationMs: 10_000,
        })),
      },
      jobs: {
        getForProject: vi.fn(async () => ({
          id: 'job-1',
          projectId: 'p1',
          type: 'audio_separation',
          status: 'running' as const,
          progress: 0.1,
          currentStep: 'separating_audio',
          errorCode: null,
          errorMessage: null,
          retryCount,
          createdAt: '',
          updatedAt: '',
        })),
        setProgress: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
        complete: vi.fn(async () => {}),
      },
      stems: {
        latestCompleted: vi.fn(async (
          _projectId: string,
          _userId: string,
          _sourceGeneration: number,
          kind: 'background' | 'dialogue',
        ) => {
          const stem = stems.get(kind);
          if (stem?.status !== 'completed') return null;
          return {
            id: stem.id,
            projectId: 'p1',
            sourceGeneration: 1,
            kind,
            provider,
            providerVersion: '1',
            status: 'completed' as const,
            objectKey: stem.objectKey,
            errorCode: null,
            errorMessage: null,
            createdAt: '',
            updatedAt: '',
          };
        }),
        begin: vi.fn(async (
          _projectId: string,
          _userId: string,
          _sourceGeneration: number,
          kind: 'background' | 'dialogue',
        ) => {
          const current = stems.get(kind);
          if (current?.status === 'pending' || current?.status === 'completed') {
            return {
              id: current.id,
              projectId: 'p1',
              sourceGeneration: 1,
              kind,
              provider,
              providerVersion: null,
              status: current.status,
              objectKey: current.objectKey,
              errorCode: null,
              errorMessage: null,
              createdAt: '',
              updatedAt: '',
            };
          }
          const next = { id: `stem-${++stemSerial}`, status: 'pending' as const, objectKey: null };
          stems.set(kind, next);
          return {
            id: next.id,
            projectId: 'p1',
            sourceGeneration: 1,
            kind,
            provider,
            providerVersion: null,
            status: 'pending' as const,
            objectKey: null,
            errorCode: null,
            errorMessage: null,
            createdAt: '',
            updatedAt: '',
          };
        }),
        complete: vi.fn(async (
          _projectId: string,
          stemId: string,
          _userId: string,
          objectKey: string,
        ) => {
          const entry = [...stems.entries()].find(([, stem]) => stem.id === stemId);
          expect(entry).toBeTruthy();
          stems.set(entry![0], { id: stemId, status: 'completed', objectKey });
        }),
        fail: vi.fn(async (_projectId: string, stemId: string) => {
          const entry = [...stems.entries()].find(([, stem]) => stem.id === stemId);
          expect(entry).toBeTruthy();
          stems.set(entry![0], { id: stemId, status: 'failed', objectKey: null });
        }),
      },
      provider: separation,
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
    };

    await expect(runSeparationPipeline({
      projectId: 'p1',
      userId: 'u1',
      jobId: 'job-1',
    }, deps as never, step() as never)).rejects.toThrow('provider failed');

    expect(stems.get('background')).toMatchObject({ status: 'failed' });
    expect(stems.get('dialogue')).toMatchObject({ status: 'failed' });
    expect(usage.has('job:job-1:retry:0:dialogue-separation:separator|started')).toBe(true);

    retryCount = 1;
    await expect(runSeparationPipeline({
      projectId: 'p1',
      userId: 'u1',
      jobId: 'job-1',
    }, deps as never, step() as never)).resolves.toEqual({
      status: 'completed',
      reused: false,
      backgroundObjectKey: expectedBackground,
      dialogueObjectKey: expectedDialogue,
    });

    expect(separation.separate).toHaveBeenCalledTimes(2);
    expect(stems.get('background')).toMatchObject({ status: 'completed', objectKey: expectedBackground });
    expect(stems.get('dialogue')).toMatchObject({ status: 'completed', objectKey: expectedDialogue });
    expect(usage.has('job:job-1:retry:1:dialogue-separation:separator|started')).toBe(true);
    expect(usage.has('job:job-1:retry:1:dialogue-separation:separator|completed')).toBe(true);
  });
});
