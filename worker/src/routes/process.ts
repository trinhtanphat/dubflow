import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { JobRepository, type JobStore } from '../db/jobs';
import { errorBody } from '../http/json';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';

export type ProcessRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeJobs?: (env: Env) => JobStore;
};

function streamAdmissionError(env: Env) {
  if (!env.STREAM) {
    return errorBody('STREAM_BINDING_UNAVAILABLE', 'Cloudflare Stream binding is unavailable.');
  }
  if (!env.STREAM_SOURCE_SIGNING_SECRET?.trim()) {
    return errorBody('STREAM_SOURCE_SIGNING_UNAVAILABLE', 'Stream source signing secret is unavailable.');
  }
  return null;
}

export function createProcessRoutes(deps: ProcessRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));

  routes.post('/:id/process', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const projects = makeProjects(c.env);
    const jobs = makeJobs(c.env);
    try {
      const project = await projects.getByIdForUser(projectId, userId);
      if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      if (!project.sourceObjectKey) return c.json(errorBody('SOURCE_MEDIA_REQUIRED', 'Upload source media before processing.'), 400);

      const rateLimited = await enforceRateLimit(c, 'process', userId, projectId);
      if (rateLimited) return rateLimited;

      const admissionError = streamAdmissionError(c.env);
      if (admissionError) return c.json(admissionError, 503);

      const job = await jobs.create(projectId, 'dubbing');
      try {
        const instance = await c.env.DUBBING_WORKFLOW.create({
          params: { projectId, userId, jobId: job.id, requestId: c.get('requestId') },
        });
        return c.json({ jobId: job.id, workflowId: instance.id, status: 'queued' as const }, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to start Cloudflare Workflow.';
        await jobs.fail(job.id, 'WORKFLOW_START_FAILED', message);
        await projects.setStatus(projectId, userId, 'failed');
        return c.json(errorBody('WORKFLOW_START_FAILED', message), 503);
      }
    } catch {
      return c.json(errorBody('PROCESS_FAILED', 'Unable to start processing.'), 500);
    }
  });
  return routes;
}
