import type { AudioSeparation } from '../db/audio-separation';
import { separationObjectPrefix } from '../db/audio-separation';
import type { JobStore } from '../db/jobs';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import type { AudioSeparationProvider, SeparationCapabilities, SeparationResult } from '../services/separation/types';
import { assertJobActive, type JobStatusReader } from './jobCancellation';

export type SeparationWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  requestId?: string;
};

type ProjectSnapshot = {
  id: string;
  sourceObjectKey: string | null;
  sourceRevision: number;
  sizeBytes?: number | null;
  durationMs?: number | null;
};

type ProjectReader = {
  getByIdForUser(projectId: string, userId: string): Promise<ProjectSnapshot | null>;
};

type SeparationStore = {
  getCurrent(
    projectId: string,
    userId: string,
    sourceRevision: number,
    provider: string,
    modelDigest: string,
  ): Promise<AudioSeparation | null>;
  createQueued(input: {
    projectId: string;
    userId: string;
    sourceRevision: number;
    sourceObjectKey: string;
    sourceSizeBytes?: number | null;
    provider: string;
    modelId: string;
    modelDigest: string;
    jobId?: string | null;
  }): Promise<AudioSeparation>;
  markRunning(projectId: string, separationId: string, userId: string): Promise<void>;
  complete(
    projectId: string,
    separationId: string,
    userId: string,
    identity: { sourceRevision: number; provider: string; modelDigest: string },
    keys: { backgroundObjectKey: string; dialogueObjectKey: string },
  ): Promise<void>;
  fail(projectId: string, separationId: string, userId: string, code: string, message: string): Promise<void>;
};

type SeparationUsageEvent = {
  phase: 'started' | 'completed';
  operationKey: string;
  units?: number;
};

type SeparationUsageStore = {
  getByOperation(operationKey: string, phase: 'started' | 'completed'): Promise<SeparationUsageEvent | null>;
  record(input: {
    userId: string;
    projectId: string;
    jobId: string;
    kind: 'audio_separation_minute';
    units: number;
    provider: string;
    phase: 'started' | 'completed';
    operationKey: string;
  }): Promise<SeparationUsageEvent>;
};

type WorkflowStep = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

type SeparationJobStore = JobStatusReader & Pick<JobStore, 'setProgress' | 'complete' | 'fail'>;

export type SeparationPipelineDeps = {
  projects: ProjectReader;
  jobs: SeparationJobStore;
  separations: SeparationStore;
  provider: AudioSeparationProvider;
  usage: SeparationUsageStore;
  telemetry: TelemetrySink;
};

export type SeparationPipelineResult = {
  status: 'completed';
  separationId: string;
  reused: boolean;
  recovered?: boolean;
};

function operationKey(projectId: string, sourceRevision: number, capabilities: SeparationCapabilities): string {
  return `project:${projectId}:source:${sourceRevision}:separation:${capabilities.provider}:${capabilities.modelDigest}`;
}

function canonicalKeys(projectId: string, sourceRevision: number, capabilities: SeparationCapabilities) {
  const prefix = separationObjectPrefix(projectId, sourceRevision, capabilities.provider, capabilities.modelDigest);
  return {
    dialogueObjectKey: `${prefix}dialogue.wav`,
    backgroundObjectKey: `${prefix}background.wav`,
  };
}

function assertValidProviderResult(result: SeparationResult, expected: ReturnType<typeof canonicalKeys>): void {
  if (!Number.isFinite(result.durationMs) || result.durationMs <= 0) {
    throw new Error('SEPARATION_RESPONSE_INVALID: provider returned an invalid duration.');
  }
  if (result.dialogueObjectKey !== expected.dialogueObjectKey || result.backgroundObjectKey !== expected.backgroundObjectKey) {
    throw new Error('SEPARATION_RESPONSE_INVALID: provider returned non-canonical artifact keys.');
  }
}

function sourceMinutes(project: ProjectSnapshot): number {
  if (!Number.isFinite(project.durationMs) || (project.durationMs ?? 0) <= 0) {
    throw new Error('SEPARATION_USAGE_RECOVERY_UNAVAILABLE: project duration is missing or invalid.');
  }
  return project.durationMs! / 60_000;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof (error as Error & { code?: unknown }).code === 'string') {
    return (error as Error & { code: string }).code;
  }
  return 'SEPARATION_FAILED';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSeparationPipeline(
  params: SeparationWorkflowParams,
  deps: SeparationPipelineDeps,
  step: WorkflowStep,
): Promise<SeparationPipelineResult> {
  const project = await step.do('load-project-source', async () => deps.projects.getByIdForUser(params.projectId, params.userId));
  if (!project) throw new Error('Project not found.');
  if (!project.sourceObjectKey || !Number.isInteger(project.sourceRevision) || project.sourceRevision < 1) {
    throw new Error('SEPARATION_SOURCE_UNAVAILABLE: project has no durable source media.');
  }

  const capabilities = await step.do('resolve-separation-provider', async () => deps.provider.capabilities());
  if (!capabilities.configured) throw new Error('SEPARATION_PROVIDER_UNAVAILABLE: provider is not configured.');
  if (!capabilities.qualified) throw new Error('SEPARATION_PROVIDER_UNQUALIFIED: provider is not runtime-qualified.');

  const opKey = operationKey(project.id, project.sourceRevision, capabilities);
  const expectedKeys = canonicalKeys(project.id, project.sourceRevision, capabilities);

  let separation = await step.do('load-current-separation', async () => deps.separations.getCurrent(
    project.id,
    params.userId,
    project.sourceRevision,
    capabilities.provider,
    capabilities.modelDigest,
  ));
  const completedUsage = await step.do('load-completed-usage', async () => deps.usage.getByOperation(opKey, 'completed'));

  if (separation?.status === 'completed') {
    if (separation.dialogueObjectKey !== expectedKeys.dialogueObjectKey || separation.backgroundObjectKey !== expectedKeys.backgroundObjectKey) {
      throw new Error('SEPARATION_ARTIFACT_MISSING: completed separation does not contain canonical stems.');
    }
    if (!completedUsage) {
      await step.do('recover-completed-usage-from-durable-separation', async () => deps.usage.record({
        userId: params.userId,
        projectId: project.id,
        jobId: separation!.jobId ?? params.jobId,
        kind: 'audio_separation_minute',
        units: sourceMinutes(project),
        provider: capabilities.provider,
        phase: 'completed',
        operationKey: opKey,
      }));
      return { status: 'completed', separationId: separation.id, reused: true, recovered: true };
    }
    return { status: 'completed', separationId: separation.id, reused: true };
  }

  if (completedUsage) {
    throw new Error('SEPARATION_INVARIANT_VIOLATION: completed usage exists without durable completed stems.');
  }

  if (!separation) {
    separation = await step.do('create-separation', async () => deps.separations.createQueued({
      projectId: project.id,
      userId: params.userId,
      sourceRevision: project.sourceRevision,
      sourceObjectKey: project.sourceObjectKey!,
      sourceSizeBytes: project.sizeBytes ?? null,
      provider: capabilities.provider,
      modelId: capabilities.modelId,
      modelDigest: capabilities.modelDigest,
      jobId: params.jobId,
    }));
  }

  await step.do('check-cancellation-before-separation', async () => assertJobActive(deps.jobs, project.id, params.jobId, params.userId));
  await step.do('mark-separation-running', async () => deps.separations.markRunning(project.id, separation!.id, params.userId));
  await step.do('mark-separation-job-running', async () => deps.jobs.setProgress(params.jobId, 0.1, 'separating_audio'));

  const started = await step.do('load-started-usage', async () => deps.usage.getByOperation(opKey, 'started'));
  if (!started) {
    await step.do('record-separation-started', async () => deps.usage.record({
      userId: params.userId,
      projectId: project.id,
      jobId: params.jobId,
      kind: 'audio_separation_minute',
      units: Number.isFinite(project.durationMs) && (project.durationMs ?? 0) > 0 ? project.durationMs! / 60_000 : 0,
      provider: capabilities.provider,
      phase: 'started',
      operationKey: opKey,
    }));
  }

  let providerResult: SeparationResult;
  try {
    providerResult = await step.do('run-audio-separation', async () => withProviderTelemetry(
      deps.telemetry,
      {
        requestId: params.requestId,
        actorId: params.userId,
        projectId: project.id,
        jobId: params.jobId,
        operation: 'audio_separation',
        provider: capabilities.provider,
        errorCode: 'SEPARATION_FAILED',
      },
      async () => {
        const result = await deps.provider.separate({
          projectId: project.id,
          sourceObjectKey: project.sourceObjectKey!,
          sourceRevision: project.sourceRevision,
          provider: capabilities.provider,
          modelId: capabilities.modelId,
          modelDigest: capabilities.modelDigest,
        });
        assertValidProviderResult(result, expectedKeys);
        return result;
      },
    ));
  } catch (error) {
    const code = errorCode(error);
    const message = errorMessage(error);
    await step.do('mark-separation-failed', async () => deps.separations.fail(
      project.id,
      separation!.id,
      params.userId,
      code,
      message,
    ));
    await step.do('mark-separation-job-failed', async () => deps.jobs.fail(params.jobId, code, message));
    throw error;
  }

  await step.do('check-cancellation-before-completion', async () => assertJobActive(deps.jobs, project.id, params.jobId, params.userId));

  await step.do('persist-separation-completion', async () => deps.separations.complete(
    project.id,
    separation!.id,
    params.userId,
    {
      sourceRevision: project.sourceRevision,
      provider: capabilities.provider,
      modelDigest: capabilities.modelDigest,
    },
    expectedKeys,
  ));

  const completedAfterPersist = await step.do('load-completed-usage-after-persist', async () => deps.usage.getByOperation(opKey, 'completed'));
  if (!completedAfterPersist) {
    await step.do('record-separation-completed-usage', async () => deps.usage.record({
      userId: params.userId,
      projectId: project.id,
      jobId: params.jobId,
      kind: 'audio_separation_minute',
      units: providerResult.durationMs / 60_000,
      provider: capabilities.provider,
      phase: 'completed',
      operationKey: opKey,
    }));
  }

  await step.do('complete-separation-job', async () => deps.jobs.complete(params.jobId));
  return { status: 'completed', separationId: separation.id, reused: false };
}
