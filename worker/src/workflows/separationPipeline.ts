import type { AudioStemRepository } from '../db/audio-stems';
import type { DubbingJob, JobStore } from '../db/jobs';
import type { ProjectStore } from '../db/projects';
import type { UsageStore } from '../db/usage';
import {
  DialogueSeparationError,
  type DialogueSeparationProvider,
  type SeparationResult,
} from '../services/separation/types';
import { assertJobActive, type JobStatusReader } from './jobCancellation';

export type SeparationWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  requestId?: string;
};

type SeparationJobs = JobStatusReader & Pick<JobStore, 'getForProject' | 'setProgress' | 'complete' | 'fail'>;
type SeparationStems = Pick<AudioStemRepository, 'latestCompleted' | 'begin' | 'complete' | 'fail'>;
type SeparationUsage = Pick<UsageStore, 'getByOperation' | 'record'>;

export type SeparationPipelineDeps = {
  projects: Pick<ProjectStore, 'getByIdForUser'>;
  jobs: SeparationJobs;
  stems: SeparationStems;
  provider: DialogueSeparationProvider;
  usage: SeparationUsage;
};

type WorkflowStep = { do<T>(name: string, callback: () => Promise<T>): Promise<T> };

function operationKey(job: Pick<DubbingJob, 'id' | 'retryCount'>, provider: string): string {
  return `job:${job.id}:retry:${job.retryCount}:dialogue-separation:${provider}`;
}

function expectedKeys(projectId: string, sourceGeneration: number, provider: string) {
  const prefix = `projects/${projectId}/stems/${sourceGeneration}/${provider}`;
  return { background: `${prefix}/background.wav`, dialogue: `${prefix}/dialogue.wav` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Dialogue separation failed.';
}

function errorCode(error: unknown): string {
  return error instanceof DialogueSeparationError ? error.code : 'DIALOGUE_SEPARATION_FAILED';
}

function assertResult(result: SeparationResult, provider: string, expected: ReturnType<typeof expectedKeys>): void {
  if (
    result.provider !== provider
    || result.backgroundObjectKey !== expected.background
    || result.dialogueObjectKey !== expected.dialogue
  ) {
    throw new DialogueSeparationError(
      'DIALOGUE_SEPARATION_ARTIFACT_INVALID',
      'Dialogue separation returned non-canonical artifacts.',
    );
  }
}

export async function runSeparationPipeline(
  params: SeparationWorkflowParams,
  deps: SeparationPipelineDeps,
  step: WorkflowStep,
): Promise<{ status: 'completed'; reused: boolean; backgroundObjectKey: string; dialogueObjectKey: string }> {
  const project = await step.do('authorize separation project', () => deps.projects.getByIdForUser(params.projectId, params.userId));
  if (!project) throw new Error('Project not found.');
  if (!project.sourceObjectKey || !Number.isInteger(project.sourceGeneration) || project.sourceGeneration < 1) {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', 'Project source media is unavailable.');
  }
  const durationMs = Number(project.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', 'Validated source duration is required.');
  }
  const job = await step.do('load separation retry generation', () => deps.jobs.getForProject(project.id, params.jobId, params.userId));
  if (!job) throw new Error('Job not found.');
  await step.do('check separation cancellation', () => assertJobActive(deps.jobs, project.id, params.jobId, params.userId));

  const capabilities = await step.do('load separation capabilities', () => deps.provider.capabilities());
  if (capabilities.qualification !== 'qualified') {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_UNQUALIFIED', 'Dialogue separation has not been runtime-qualified.');
  }
  if (!capabilities.configured || !capabilities.backgroundStem || !capabilities.dialogueStem || !capabilities.provider) {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_UNAVAILABLE', 'Dialogue separation is unavailable.');
  }
  if (capabilities.maxDurationMs !== undefined && durationMs > capabilities.maxDurationMs) {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_UNAVAILABLE', 'Source exceeds separator duration capacity.');
  }

  const provider = capabilities.provider;
  const expected = expectedKeys(project.id, project.sourceGeneration, provider);
  const [readyBackground, readyDialogue] = await Promise.all([
    step.do('load completed background stem', () => deps.stems.latestCompleted(project.id, params.userId, project.sourceGeneration, 'background', provider)),
    step.do('load completed dialogue stem', () => deps.stems.latestCompleted(project.id, params.userId, project.sourceGeneration, 'dialogue', provider)),
  ]);
  if (readyBackground?.objectKey === expected.background && readyDialogue?.objectKey === expected.dialogue) {
    await step.do('complete reused separation job', () => deps.jobs.complete(params.jobId));
    return { status: 'completed', reused: true, backgroundObjectKey: expected.background, dialogueObjectKey: expected.dialogue };
  }

  const [backgroundStem, dialogueStem] = await Promise.all([
    step.do('claim background stem', () => deps.stems.begin(project.id, params.userId, project.sourceGeneration, 'background', provider, null)),
    step.do('claim dialogue stem', () => deps.stems.begin(project.id, params.userId, project.sourceGeneration, 'dialogue', provider, null)),
  ]);
  await step.do('mark separation running', () => deps.jobs.setProgress(params.jobId, 0.1, 'separating_audio'));

  const key = operationKey(job, provider);
  const units = durationMs / 1000;
  const started = await step.do('load separation started usage', () => deps.usage.getByOperation(key, 'started'));
  if (!started) {
    await step.do('record separation started usage', () => deps.usage.record({
      userId: params.userId,
      projectId: project.id,
      jobId: params.jobId,
      kind: 'dialogue_separation_second',
      units,
      provider,
      phase: 'started',
      operationKey: key,
    }));
  }

  let result: SeparationResult;
  try {
    result = await step.do('run dialogue separation provider', () => deps.provider.separate({
      projectId: project.id,
      sourceObjectKey: project.sourceObjectKey!,
      sourceGeneration: project.sourceGeneration,
      durationMs,
    }));
    assertResult(result, provider, expected);
  } catch (error) {
    const code = errorCode(error);
    const message = errorMessage(error);
    await Promise.allSettled([
      deps.stems.fail(project.id, backgroundStem.id, params.userId, code, message),
      deps.stems.fail(project.id, dialogueStem.id, params.userId, code, message),
      deps.jobs.fail(params.jobId, code, message),
    ]);
    throw error;
  }

  await step.do('check separation cancellation before publish', () => assertJobActive(deps.jobs, project.id, params.jobId, params.userId));
  await step.do('persist separated stems', async () => {
    await deps.stems.complete(project.id, backgroundStem.id, params.userId, expected.background, result.providerVersion ?? null);
    await deps.stems.complete(project.id, dialogueStem.id, params.userId, expected.dialogue, result.providerVersion ?? null);
  });
  const completed = await step.do('load separation completed usage', () => deps.usage.getByOperation(key, 'completed'));
  if (!completed) {
    await step.do('record separation completed usage', () => deps.usage.record({
      userId: params.userId,
      projectId: project.id,
      jobId: params.jobId,
      kind: 'dialogue_separation_second',
      units,
      provider,
      phase: 'completed',
      operationKey: key,
    }));
  }
  await step.do('complete separation job', () => deps.jobs.complete(params.jobId));
  return { status: 'completed', reused: false, backgroundObjectKey: expected.background, dialogueObjectKey: expected.dialogue };
}
