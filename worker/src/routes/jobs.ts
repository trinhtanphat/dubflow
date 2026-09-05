import { Hono } from 'hono';
import type { Env } from '../env';
import { JobRepository, JobStateError, type DubbingJob, type JobStore } from '../db/jobs';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';

export type JobStoreFactory = (env: Env) => JobStore;

type RetryWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  usageAttempt: number;
};

export type JobRouteDeps = {
  makeStore?: JobStoreFactory;
  startWorkflow?: (
    env: Env,
    job: DubbingJob,
    params: RetryWorkflowParams,
  ) => Promise<{ id: string }>;
};

async function defaultStartWorkflow(
  env: Env,
  job: DubbingJob,
  params: RetryWorkflowParams,
): Promise<{ id: string }> {
  const binding = job.type === 'dubbing'
    ? env.DUBBING_WORKFLOW
    : job.type === 'export'
      ? env.EXPORT_WORKFLOW
      : null;
  if (!binding) throw new JobStateError('JOB_TYPE_UNSUPPORTED', `Unsupported retry job type: ${job.type}.`);
  return binding.create({ id: `retry-${job.id}-${job.retryCount}`, params });
}

function statusForJobError(error: JobStateError): 404 | 409 {
  return error.code === 'JOB_NOT_FOUND' ? 404 : 409;
}

function jobErrorResponse(c: any, error: unknown) {
  if (error instanceof JobStateError) {
    return c.json(errorBody(error.code, error.message), statusForJobError(error));
  }
  const message = error instanceof Error ? error.message : 'Unable to update job.';
  return c.json(errorBody('JOB_CONTROL_FAILED', message), 500);
}

export function createJobRoutes(
  input: JobStoreFactory | JobRouteDeps = {},
) {
  const deps: JobRouteDeps = typeof input === 'function' ? { makeStore: input } : input;
  const makeStore = deps.makeStore ?? ((env: Env) => new JobRepository(env.DB));
  const startWorkflow = deps.startWorkflow ?? defaultStartWorkflow;
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/:id/jobs', async (c) => {
    try {
      const jobs = await makeStore(c.env).listForProject(c.req.param('id'), getCurrentUserId());
      return c.json(jobs);
    } catch (error) {
      return jobErrorResponse(c, error);
    }
  });

  routes.get('/:id/jobs/:jobId', async (c) => {
    const job = await makeStore(c.env).getForProject(
      c.req.param('id'),
      c.req.param('jobId'),
      getCurrentUserId(),
    );
    return job
      ? c.json(job)
      : c.json(errorBody('JOB_NOT_FOUND', 'Job not found.'), 404);
  });

  routes.post('/:id/jobs/:jobId/retry', async (c) => {
    const projectId = c.req.param('id');
    const jobId = c.req.param('jobId');
    const userId = getCurrentUserId();
    const jobs = makeStore(c.env);
    try {
      const current = await jobs.getForProject(projectId, jobId, userId);
      if (!current) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
      if (!['dubbing', 'export'].includes(current.type)) {
        throw new JobStateError('JOB_TYPE_UNSUPPORTED', `Unsupported retry job type: ${current.type}.`);
      }

      const retrying = await jobs.markRetrying(projectId, jobId, userId);
      try {
        const instance = await startWorkflow(c.env, retrying, {
          projectId,
          userId,
          jobId,
          usageAttempt: retrying.retryCount,
        });
        return c.json({ jobId, workflowId: instance.id, status: 'retrying' as const }, 202);
      } catch (error) {
        if (error instanceof JobStateError && error.code === 'JOB_TYPE_UNSUPPORTED') throw error;
        const message = error instanceof Error ? error.message : 'Unable to start retry Workflow.';
        await jobs.fail(jobId, 'WORKFLOW_RETRY_START_FAILED', message);
        return c.json(errorBody('WORKFLOW_RETRY_START_FAILED', message), 503);
      }
    } catch (error) {
      return jobErrorResponse(c, error);
    }
  });

  routes.post('/:id/jobs/:jobId/cancel', async (c) => {
    try {
      const job = await makeStore(c.env).cancel(
        c.req.param('id'),
        c.req.param('jobId'),
        getCurrentUserId(),
      );
      return c.json(job);
    } catch (error) {
      return jobErrorResponse(c, error);
    }
  });

  return routes;
}
