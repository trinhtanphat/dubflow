import { Hono } from 'hono';
import type { Env } from '../env';
import { AudioStemRepository, type AudioStem } from '../db/audio-stems';
import { JobRepository, JobStateError, type DubbingJob, type JobStore } from '../db/jobs';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { errorBody } from '../http/json';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { createDialogueSeparationProvider } from '../services/separation/config';
import type { DialogueSeparationCapabilities, DialogueSeparationProvider } from '../services/separation/types';

export type SeparationRouteDeps = {
  makeProjects?: (env: Env) => Pick<ProjectStore, 'getByIdForUser'>;
  makeJobs?: (env: Env) => Pick<JobStore, 'create' | 'listForProject' | 'markRetrying' | 'fail'>;
  makeStems?: (env: Env) => Pick<AudioStemRepository, 'latestCompleted' | 'latest'>;
  makeProvider?: (env: Env) => DialogueSeparationProvider;
};

type Lifecycle = 'not_prepared' | 'processing' | 'ready' | 'failed' | 'stale';

function latestSeparationJob(jobs: DubbingJob[]): DubbingJob | null {
  return jobs.find((job) => job.type === 'audio_separation') ?? null;
}

function qualified(capabilities: DialogueSeparationCapabilities): boolean {
  return capabilities.qualification === 'qualified';
}

function statePayload(
  status: Lifecycle,
  capabilities: DialogueSeparationCapabilities,
  stem: AudioStem | null,
  job: DubbingJob | null,
) {
  return {
    status,
    qualified: qualified(capabilities),
    provider: capabilities.provider,
    stem: stem ? {
      id: stem.id,
      status: stem.status,
      sourceGeneration: stem.sourceGeneration,
      provider: stem.provider,
      providerVersion: stem.providerVersion,
      objectKey: stem.objectKey,
      errorCode: stem.errorCode,
      errorMessage: stem.errorMessage,
      updatedAt: stem.updatedAt,
    } : null,
    job: job ? {
      id: job.id,
      status: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      retryCount: job.retryCount,
      updatedAt: job.updatedAt,
    } : null,
  };
}

function capabilityError(capabilities: DialogueSeparationCapabilities): { code: string; message: string; status: 409 | 503 } | null {
  if (capabilities.qualification === 'unqualified') {
    return {
      code: 'DIALOGUE_SEPARATION_UNQUALIFIED',
      message: 'Dialogue separation has not been runtime-qualified.',
      status: 409,
    };
  }
  if (!capabilities.configured || capabilities.qualification !== 'qualified' || !capabilities.backgroundStem || !capabilities.dialogueStem || !capabilities.provider) {
    return {
      code: 'DIALOGUE_SEPARATION_UNAVAILABLE',
      message: 'Dialogue separation is unavailable.',
      status: 503,
    };
  }
  return null;
}

async function retryRequested(c: { req: { header(name: string): string | undefined; json(): Promise<unknown> } }): Promise<boolean> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return false;
  try {
    const body = await c.req.json();
    return Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as { retry?: unknown }).retry === true);
  } catch {
    return false;
  }
}

function expectedBackgroundKey(projectId: string, sourceGeneration: number, provider: string): string {
  return `projects/${projectId}/stems/${sourceGeneration}/${provider}/background.wav`;
}

export function createSeparationRoutes(deps: SeparationRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeStems = deps.makeStems ?? ((env: Env) => new AudioStemRepository(env.DB));
  const makeProvider = deps.makeProvider ?? ((env: Env) => createDialogueSeparationProvider(env));

  routes.get('/:id/separation', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const capabilities = await makeProvider(c.env).capabilities();
    if (!project.sourceObjectKey || !Number.isInteger(project.sourceGeneration) || project.sourceGeneration < 1 || !capabilities.provider) {
      return c.json(statePayload('not_prepared', capabilities, null, null));
    }
    const [stem, jobs] = await Promise.all([
      makeStems(c.env).latest(projectId, userId, project.sourceGeneration, 'background', capabilities.provider),
      makeJobs(c.env).listForProject(projectId, userId),
    ]);
    const job = latestSeparationJob(jobs);
    let status: Lifecycle = 'not_prepared';
    const expected = expectedBackgroundKey(projectId, project.sourceGeneration, capabilities.provider);
    if (stem?.status === 'completed' && stem.objectKey === expected) status = 'ready';
    else if (stem?.status === 'failed' || job?.status === 'failed') status = 'failed';
    else if (stem?.status === 'invalidated') status = 'stale';
    else if (stem?.status === 'pending' || ['queued', 'running', 'retrying'].includes(job?.status ?? '')) status = 'processing';
    else if (job?.status === 'completed') status = 'stale';
    return c.json(statePayload(status, capabilities, stem, job));
  });

  routes.post('/:id/separation', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const projects = makeProjects(c.env);
    const jobsStore = makeJobs(c.env);
    const stems = makeStems(c.env);
    const provider = makeProvider(c.env);

    try {
      const project = await projects.getByIdForUser(projectId, userId);
      if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      if (!project.sourceObjectKey || !Number.isInteger(project.sourceGeneration) || project.sourceGeneration < 1) {
        return c.json(errorBody('SEPARATION_SOURCE_UNAVAILABLE', 'Upload durable source media before preparing background audio.'), 409);
      }
      const durationMs = Number(project.durationMs);
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return c.json(errorBody('SEPARATION_DURATION_UNAVAILABLE', 'Validated source duration is required before preparing background audio.'), 409);
      }

      const capabilities = await provider.capabilities();
      const admission = capabilityError(capabilities);
      if (admission) return c.json(errorBody(admission.code, admission.message), admission.status);
      if (capabilities.maxDurationMs !== undefined && durationMs > capabilities.maxDurationMs) {
        return c.json(errorBody('SEPARATION_DURATION_UNSUPPORTED', 'Source exceeds separator duration capacity.'), 409);
      }
      const providerId = capabilities.provider!;
      const [ready, allJobs] = await Promise.all([
        stems.latestCompleted(projectId, userId, project.sourceGeneration, 'background', providerId),
        jobsStore.listForProject(projectId, userId),
      ]);
      const currentJob = latestSeparationJob(allJobs);
      const expected = expectedBackgroundKey(projectId, project.sourceGeneration, providerId);
      if (ready?.objectKey === expected) {
        return c.json({ ...statePayload('ready', capabilities, ready, currentJob), reused: true }, 200);
      }
      if (currentJob && ['queued', 'running', 'retrying'].includes(currentJob.status)) {
        return c.json({ ...statePayload('processing', capabilities, null, currentJob), reused: true }, 202);
      }

      const retry = await retryRequested(c);
      let job: DubbingJob;
      if (currentJob?.status === 'failed') {
        if (!retry) return c.json(errorBody('SEPARATION_RETRY_REQUIRED', 'Failed separation requires explicit retry.'), 409);
        job = await jobsStore.markRetrying(projectId, currentJob.id, userId);
      } else {
        job = await jobsStore.create(projectId, 'audio_separation');
      }

      const rateLimited = await enforceRateLimit(c, 'separation', userId, projectId);
      if (rateLimited) return rateLimited;
      if (!c.env.SEPARATION_WORKFLOW) {
        await jobsStore.fail(job.id, 'DIALOGUE_SEPARATION_UNAVAILABLE', 'Separation workflow binding is unavailable.');
        return c.json(errorBody('DIALOGUE_SEPARATION_UNAVAILABLE', 'Separation workflow binding is unavailable.'), 503);
      }
      try {
        const workflow = await c.env.SEPARATION_WORKFLOW.create({
          id: `separation-${job.id}-retry-${job.retryCount}`,
          params: { projectId, userId, jobId: job.id, requestId: c.get('requestId') },
        });
        return c.json({ ...statePayload('processing', capabilities, null, job), reused: currentJob?.id === job.id, workflowId: workflow.id }, 202);
      } catch {
        await jobsStore.fail(job.id, 'WORKFLOW_START_FAILED', 'Unable to start separation workflow.');
        return c.json(errorBody('WORKFLOW_START_FAILED', 'Unable to start separation workflow.'), 503);
      }
    } catch (error) {
      if (error instanceof JobStateError) return c.json(errorBody(error.code, error.message), 409);
      return c.json(errorBody('SEPARATION_FAILED', 'Unable to prepare background audio.'), 500);
    }
  });

  return routes;
}
