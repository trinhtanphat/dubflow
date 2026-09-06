import { Hono } from 'hono';
import type { Env } from '../env';
import {
  AudioSeparationPersistenceError,
  AudioSeparationRepository,
  type AudioSeparation,
} from '../db/audio-separation';
import { JobRepository, JobStateError, type JobStore } from '../db/jobs';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { errorBody } from '../http/json';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { createSeparationProvider } from '../services/separation/config';
import type { AudioSeparationProvider } from '../services/separation/types';

export type SeparationRouteDeps = {
  makeProjects?: (env: Env) => Pick<ProjectStore, 'getByIdForUser'>;
  makeJobs?: (env: Env) => Pick<JobStore, 'create' | 'markRetrying' | 'fail'>;
  makeSeparations?: (env: Env) => Pick<AudioSeparationRepository, 'getCurrent' | 'createQueued' | 'fail'>;
  makeProvider?: (env: Env) => AudioSeparationProvider;
};

type SeparationRouteErrorStatus = 400 | 404 | 409 | 500 | 503;

class SeparationRouteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: SeparationRouteErrorStatus,
  ) {
    super(message);
    this.name = 'SeparationRouteError';
  }
}

function safeSeparation(separation: AudioSeparation) {
  return {
    id: separation.id,
    status: separation.status,
    sourceRevision: separation.sourceRevision,
    provider: separation.provider,
    modelId: separation.modelId,
    jobId: separation.jobId,
    errorCode: separation.errorCode,
    errorMessage: separation.errorMessage,
    createdAt: separation.createdAt,
    completedAt: separation.completedAt,
  };
}

async function retryRequested(c: { req: { header(name: string): string | undefined; json(): Promise<unknown> } }): Promise<boolean> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return false;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new SeparationRouteError('INVALID_JSON', 'Separation request body must be valid JSON.', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return (body as Record<string, unknown>).retry === true;
}

function assertSourceReady(project: {
  sourceObjectKey?: string | null;
  sourceRevision: number;
}): asserts project is { sourceObjectKey: string; sourceRevision: number } {
  if (!project.sourceObjectKey || !Number.isInteger(project.sourceRevision) || project.sourceRevision < 1) {
    throw new SeparationRouteError(
      'SEPARATION_SOURCE_UNAVAILABLE',
      'Upload durable source media before preparing background audio.',
      409,
    );
  }
}

function assertProviderAdmission(
  capabilities: Awaited<ReturnType<AudioSeparationProvider['capabilities']>>,
  durationMs?: number | null,
): void {
  if (!capabilities.configured) {
    throw new SeparationRouteError('SEPARATION_PROVIDER_UNAVAILABLE', 'Audio separation provider is unavailable.', 503);
  }
  if (!capabilities.qualified) {
    throw new SeparationRouteError(
      'SEPARATION_PROVIDER_UNQUALIFIED',
      'Audio separation is not runtime-qualified for production work.',
      503,
    );
  }
  if (!Number.isFinite(durationMs) || (durationMs ?? 0) <= 0) {
    throw new SeparationRouteError(
      'SEPARATION_DURATION_UNAVAILABLE',
      'Validated source duration is required before starting audio separation.',
      409,
    );
  }
  if (capabilities.maxDurationMs !== undefined && durationMs! > capabilities.maxDurationMs) {
    throw new SeparationRouteError(
      'SEPARATION_DURATION_UNSUPPORTED',
      'Source duration exceeds the configured audio separation capacity.',
      409,
    );
  }
}

function routeError(error: unknown): { code: string; message: string; status: SeparationRouteErrorStatus } {
  if (error instanceof SeparationRouteError) return error;
  if (error instanceof AudioSeparationPersistenceError) {
    if (error.code === 'PROJECT_NOT_FOUND' || error.code === 'SEPARATION_NOT_FOUND') {
      return { code: error.code, message: error.message, status: 404 };
    }
    return { code: error.code, message: error.message, status: 409 };
  }
  if (error instanceof JobStateError) {
    if (error.code === 'JOB_NOT_FOUND') return { code: error.code, message: error.message, status: 404 };
    return { code: error.code, message: error.message, status: 409 };
  }
  return { code: 'SEPARATION_FAILED', message: 'Unable to prepare background audio.', status: 500 };
}

export function createSeparationRoutes(deps: SeparationRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeSeparations = deps.makeSeparations ?? ((env: Env) => new AudioSeparationRepository(env.DB));
  const makeProvider = deps.makeProvider ?? ((env: Env) => createSeparationProvider(env));

  routes.get('/:id/separation', async (c) => {
    try {
      const userId = getCurrentUserId();
      const projectId = c.req.param('id');
      const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
      if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

      const capabilities = await makeProvider(c.env).capabilities();
      if (!project.sourceObjectKey || !Number.isInteger(project.sourceRevision) || project.sourceRevision < 1) {
        return c.json({ status: 'not_prepared' as const, qualified: capabilities.qualified, separation: null });
      }
      const separation = await makeSeparations(c.env).getCurrent(
        projectId,
        userId,
        project.sourceRevision,
        capabilities.provider,
        capabilities.modelDigest,
      );
      return c.json({
        status: separation?.status ?? ('not_prepared' as const),
        qualified: capabilities.qualified,
        separation: separation ? safeSeparation(separation) : null,
      });
    } catch (error) {
      const safe = routeError(error);
      return c.json(errorBody(safe.code, safe.message), safe.status);
    }
  });

  routes.post('/:id/separation', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const projects = makeProjects(c.env);
    const jobs = makeJobs(c.env);
    const separations = makeSeparations(c.env);
    const provider = makeProvider(c.env);

    try {
      const project = await projects.getByIdForUser(projectId, userId);
      if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      assertSourceReady(project);

      const capabilities = await provider.capabilities();
      const current = await separations.getCurrent(
        projectId,
        userId,
        project.sourceRevision,
        capabilities.provider,
        capabilities.modelDigest,
      );

      if (current?.status === 'completed') {
        return c.json({ status: 'completed' as const, reused: true, separation: safeSeparation(current) }, 200);
      }
      if (current?.status === 'queued' || current?.status === 'running') {
        return c.json({ status: current.status, reused: true, separation: safeSeparation(current) }, 202);
      }

      const retry = await retryRequested(c);
      if (current?.status === 'failed' && !retry) {
        return c.json(errorBody('SEPARATION_RETRY_REQUIRED', 'Failed separation requires an explicit retry request.'), 409);
      }
      if (current?.status === 'invalidated') {
        return c.json(errorBody('SEPARATION_SOURCE_STALE', 'The current separation identity is stale.'), 409);
      }

      assertProviderAdmission(capabilities, project.durationMs);
      const rateLimited = await enforceRateLimit(c, 'separation', userId, projectId);
      if (rateLimited) return rateLimited;

      if (current?.status === 'failed') {
        if (!current.jobId) {
          throw new SeparationRouteError('SEPARATION_RETRY_UNAVAILABLE', 'Failed separation has no retryable job.', 409);
        }
        const job = await jobs.markRetrying(projectId, current.jobId, userId);
        try {
          const workflow = await c.env.SEPARATION_WORKFLOW.create({
            params: { projectId, userId, jobId: job.id, requestId: c.get('requestId') },
          });
          return c.json({
            status: 'retrying' as const,
            reused: true,
            workflowId: workflow.id,
            separation: safeSeparation(current),
          }, 202);
        } catch {
          await jobs.fail(job.id, 'WORKFLOW_START_FAILED', 'Unable to start audio separation workflow.');
          return c.json(errorBody('WORKFLOW_START_FAILED', 'Unable to start audio separation workflow.'), 503);
        }
      }

      const job = await jobs.create(projectId, 'audio_separation');
      const separation = await separations.createQueued({
        projectId,
        userId,
        sourceRevision: project.sourceRevision,
        sourceObjectKey: project.sourceObjectKey,
        sourceSizeBytes: project.sizeBytes ?? null,
        provider: capabilities.provider,
        modelId: capabilities.modelId,
        modelDigest: capabilities.modelDigest,
        jobId: job.id,
      });

      try {
        const workflow = await c.env.SEPARATION_WORKFLOW.create({
          params: { projectId, userId, jobId: job.id, requestId: c.get('requestId') },
        });
        return c.json({
          status: 'queued' as const,
          reused: false,
          jobId: job.id,
          workflowId: workflow.id,
          separation: safeSeparation(separation),
        }, 202);
      } catch {
        await jobs.fail(job.id, 'WORKFLOW_START_FAILED', 'Unable to start audio separation workflow.');
        await separations.fail(projectId, separation.id, userId, 'WORKFLOW_START_FAILED', 'Unable to start audio separation workflow.');
        return c.json(errorBody('WORKFLOW_START_FAILED', 'Unable to start audio separation workflow.'), 503);
      }
    } catch (error) {
      const safe = routeError(error);
      return c.json(errorBody(safe.code, safe.message), safe.status);
    }
  });

  return routes;
}
