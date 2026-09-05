import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { JobRepository, type JobStore } from '../db/jobs';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';

export type ProcessRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeJobs?: (env: Env) => JobStore;
};

export function createProcessRoutes(deps: ProcessRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
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

      const job = await jobs.create(projectId, 'dubbing');
      try {
        const instance = await c.env.DUBBING_WORKFLOW.create({ params: { projectId, userId, jobId: job.id } });
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
