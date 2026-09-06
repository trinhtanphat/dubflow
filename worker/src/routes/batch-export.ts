import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { JobRepository, type JobStore } from '../db/jobs';
import { MultilangRepository, type MultilangStore } from '../db/multilang';
import { parseBatchTargetLanguages } from '../domain/target-language';
import { errorBody } from '../http/json';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';

export type BatchExportRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeJobs?: (env: Env) => JobStore;
  makeMultilang?: (env: Env) => MultilangStore;
};

function voiceConfigured(env: Env) {
  return Boolean(env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_DEFAULT_VOICE_ID?.trim());
}

export function createBatchExportRoutes(deps: BatchExportRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeMultilang = deps.makeMultilang ?? ((env: Env) => new MultilangRepository(env.DB));

  routes.post('/:id/exports/batch', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const projects = makeProjects(c.env);
    const project = await projects.getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!project.sourceObjectKey) return c.json(errorBody('SOURCE_MEDIA_REQUIRED', 'Upload source media before export.'), 400);
    if (!['needs_review', 'completed'].includes(project.status)) {
      return c.json(errorBody('PROJECT_NOT_EXPORTABLE', 'Project must finish dubbing review before export.'), 409);
    }
    if (!voiceConfigured(c.env)) return c.json(errorBody('VOICE_PROVIDER_UNCONFIGURED', 'ElevenLabs voice credentials are required before export.'), 503);

    const body = await c.req.json().catch(() => null) as { targetLanguages?: unknown } | null;
    let targetLanguages;
    try {
      targetLanguages = parseBatchTargetLanguages(body?.targetLanguages);
    } catch (error) {
      return c.json(errorBody('TARGET_LANGUAGES_INVALID', error instanceof Error ? error.message : 'Invalid target languages.'), 400);
    }

    const rateLimited = await enforceRateLimit(c, 'batch-export', userId, projectId);
    if (rateLimited) return rateLimited;

    const jobs = makeJobs(c.env);
    const multilang = makeMultilang(c.env);
    const targets: Array<{ targetLanguage: string; exportId: string; jobId: string; workflowId?: string; status: 'queued' | 'failed'; errorCode?: string }> = [];
    await projects.setStatus(projectId, userId, 'processing');

    for (const targetLanguage of targetLanguages) {
      const job = await jobs.create(projectId, 'export');
      const exportId = crypto.randomUUID();
      await multilang.createExport({ id: exportId, projectId, userId, targetLanguage, jobId: job.id, generation: job.retryCount ?? 0 });
      try {
        const instance = await c.env.EXPORT_WORKFLOW.create({
          params: { projectId, userId, jobId: job.id, exportId, targetLanguage, requestId: c.get('requestId') },
        });
        targets.push({ targetLanguage, exportId, jobId: job.id, workflowId: instance.id, status: 'queued' });
      } catch {
        await multilang.failExport(projectId, exportId, userId, 'EXPORT_WORKFLOW_START_FAILED');
        await jobs.fail(job.id, 'EXPORT_WORKFLOW_START_FAILED', 'Unable to start export Workflow.');
        targets.push({ targetLanguage, exportId, jobId: job.id, status: 'failed', errorCode: 'EXPORT_WORKFLOW_START_FAILED' });
      }
    }

    if (targets.every((target) => target.status === 'failed')) await projects.setStatus(projectId, userId, 'needs_review');
    return c.json({ status: 'queued' as const, targets }, 202);
  });

  return routes;
}
