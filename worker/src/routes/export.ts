import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { JobRepository, type JobStore } from '../db/jobs';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { errorBody } from '../http/json';
import { parseByteRange } from '../services/media';

export type ExportRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeJobs?: (env: Env) => JobStore;
  makeBucket?: (env: Env) => R2ReadableBucketLike;
};

function voiceConfigured(env: Env) {
  return Boolean(env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_DEFAULT_VOICE_ID?.trim());
}

function readableBucket(env: Env): R2ReadableBucketLike {
  return {
    async head(key) {
      if (!env.MEDIA.head) return null;
      return env.MEDIA.head(key);
    },
    async get(key, options) {
      if (!env.MEDIA.get) return null;
      return env.MEDIA.get(key, options);
    },
  };
}

export function createExportRoutes(deps: ExportRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeBucket = deps.makeBucket ?? readableBucket;

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

      const rateLimited = await enforceRateLimit(c, 'export', userId, projectId);
      if (rateLimited) return rateLimited;

      const job = await jobs.create(projectId, 'export');
      await projects.setStatus(projectId, userId, 'processing');
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

  routes.get('/:id/export/media', async (c) => {
    const project = await makeProjects(c.env).getByIdForUser(c.req.param('id'), getCurrentUserId());
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!project.exportObjectKey) return c.json(errorBody('EXPORT_NOT_READY', 'Final dubbing export is not ready.'), 409);

    const bucket = makeBucket(c.env);
    const rangeHeader = c.req.header('range') ?? null;
    let parsedRange = null as ReturnType<typeof parseByteRange>;
    let totalSize = 0;

    if (rangeHeader) {
      const metadata = bucket.head ? await bucket.head(project.exportObjectKey) : null;
      if (!metadata) return c.json(errorBody('EXPORT_OBJECT_NOT_FOUND', 'Final export object not found.'), 404);
      totalSize = metadata.size;
      parsedRange = parseByteRange(rangeHeader, totalSize);
      if (!parsedRange) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}`, 'Accept-Ranges': 'bytes' },
        });
      }
    }

    const object = await bucket.get(
      project.exportObjectKey,
      parsedRange ? { range: { offset: parsedRange.offset, length: parsedRange.length } } : undefined,
    );
    if (!object) return c.json(errorBody('EXPORT_OBJECT_NOT_FOUND', 'Final export object not found.'), 404);
    if (!rangeHeader) totalSize = object.size;

    const headers = new Headers();
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'video/mp4');
    headers.set('Content-Length', String(parsedRange?.length ?? object.size));
    headers.set('Content-Disposition', `attachment; filename="${project.id}-dubbed.mp4"`);
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    if (parsedRange) headers.set('Content-Range', `bytes ${parsedRange.offset}-${parsedRange.end}/${totalSize}`);
    return new Response(object.body, { status: parsedRange ? 206 : 200, headers });
  });

  return routes;
}
