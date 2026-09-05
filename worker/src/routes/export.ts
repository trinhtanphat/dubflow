import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { JobRepository, type JobStore } from '../db/jobs';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';

export type ExportRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeJobs?: (env: Env) => JobStore;
};

function voiceConfigured(env: Env) {
  return Boolean(env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_DEFAULT_VOICE_ID?.trim());
}

export function createExportRoutes(deps: ExportRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));

  routes.post('/:id/export', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const projects = makeProjects(c.env);
    const jobs = makeJobs(c.env);

    try {
      const project = await projects.getByIdForUser(projectId, userId);
      if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      if (!project.sourceObjectKey) return c.json(errorBody('SOURCE_MEDIA_REQUIRED', 'Upload source media before export.'), 400);
      if (!['needs_review', 'completed'].includes(project.status)) {
        return c.json(errorBody('PROJECT_NOT_EXPORTABLE', 'Project must finish dubbing review before export.'), 409);
      }
      if (!voiceConfigured(c.env)) {
        return c.json(errorBody('VOICE_PROVIDER_UNCONFIGURED', 'ElevenLabs voice credentials are required before export.'), 503);
      }

      const job = await jobs.create(projectId, 'export');
      try {
        const instance = await c.env.EXPORT_WORKFLOW.create({ params: { projectId, userId, jobId: job.id } });
        return c.json({ jobId: job.id, workflowId: instance.id, status: 'queued' as const }, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to start export Workflow.';
        await jobs.fail(job.id, 'EXPORT_WORKFLOW_START_FAILED', message);
        await projects.setStatus(projectId, userId, 'needs_review');
        return c.json(errorBody('EXPORT_WORKFLOW_START_FAILED', message), 503);
      }
    } catch {
      return c.json(errorBody('EXPORT_START_FAILED', 'Unable to start final dubbing export.'), 500);
    }
  });

  return routes;
}
