import { Hono } from 'hono';
import type { Env } from '../env';
import { MultilangRepository, type MultilangStore } from '../db/multilang';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { JobRepository, type JobStore } from '../db/jobs';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { parseTargetLanguage } from '../domain/target-language';
import { errorBody } from '../http/json';
import { MediaObjectNotFoundError, streamMediaObject } from '../http/media-stream';
import { createTelemetry, emitTelemetry } from '../observability/telemetry';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';

export type ExportRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeJobs?: (env: Env) => JobStore;
  makeMultilang?: (env: Env) => MultilangStore;
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

async function readOptionalJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createExportRoutes(deps: ExportRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeMultilang = deps.makeMultilang ?? ((env: Env) => new MultilangRepository(env.DB));
  const makeBucket = deps.makeBucket ?? readableBucket;

  routes.post('/:id/export', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const projects = makeProjects(c.env);
    const jobs = makeJobs(c.env);
    const multilang = makeMultilang(c.env);

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

      const body = await readOptionalJson(c.req.raw);
      if (!body) return c.json(errorBody('INVALID_JSON', 'Request body must be a JSON object.'), 400);
      const explicitTarget = Object.prototype.hasOwnProperty.call(body, 'targetLanguage');
      let targetLanguage = 'vi' as const;
      if (explicitTarget) {
        try {
          targetLanguage = parseTargetLanguage(body.targetLanguage) as 'vi';
        } catch (error) {
          return c.json(errorBody('TARGET_LANGUAGE_INVALID', error instanceof Error ? error.message : 'Invalid target language.'), 400);
        }
      }

      const rateLimited = await enforceRateLimit(c, 'export', userId, projectId);
      if (rateLimited) return rateLimited;

      const job = await jobs.create(projectId, 'export');
      await projects.setStatus(projectId, userId, 'processing');

      if (explicitTarget) {
        const exportId = crypto.randomUUID();
        await multilang.createExport({
          id: exportId,
          projectId,
          batchId: exportId,
          userId,
          targetLanguage,
          jobId: job.id,
          generation: job.retryCount ?? 0,
        });
        try {
          const instance = await c.env.EXPORT_WORKFLOW.create({
            params: { projectId, userId, jobId: job.id, exportId, targetLanguage, requestId: c.get('requestId') },
          });
          return c.json({ jobId: job.id, workflowId: instance.id, exportId, targetLanguage, status: 'queued' as const }, 202);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to start export Workflow.';
          await multilang.failExport(projectId, exportId, userId, 'EXPORT_WORKFLOW_START_FAILED');
          await jobs.fail(job.id, 'EXPORT_WORKFLOW_START_FAILED', message);
          await projects.setStatus(projectId, userId, 'needs_review');
          return c.json(errorBody('EXPORT_WORKFLOW_START_FAILED', message), 503);
        }
      }

      try {
        const instance = await c.env.EXPORT_WORKFLOW.create({
          params: { projectId, userId, jobId: job.id, requestId: c.get('requestId') },
        });
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

  routes.get('/:id/exports', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    return c.json(await makeMultilang(c.env).listExports(projectId, userId));
  });

  routes.get('/:id/export/media', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!project.exportObjectKey) return c.json(errorBody('EXPORT_NOT_READY', 'Final dubbing export is not ready.'), 409);

    try {
      const response = await streamMediaObject(
        makeBucket(c.env),
        project.exportObjectKey,
        c.req.raw,
        `${project.id}-dubbed.mp4`,
      );
      emitTelemetry(createTelemetry(c.env), {
        name: 'export_download',
        requestId: c.get('requestId'),
        actorId: userId,
        projectId,
        accessMode: 'owner',
        httpStatus: response.status,
        rangeRequest: Boolean(c.req.header('range')),
        status: response.status < 400 ? 'success' : 'rejected',
      });
      return response;
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) {
        return c.json(errorBody('EXPORT_OBJECT_NOT_FOUND', 'Final export object not found.'), 404);
      }
      throw error;
    }
  });

  routes.get('/:id/exports/:exportId/media', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const variant = await makeMultilang(c.env).getExport(projectId, c.req.param('exportId'), userId);
    if (!variant) return c.json(errorBody('EXPORT_NOT_FOUND', 'Export not found.'), 404);
    if (variant.status !== 'completed' || !variant.objectKey) {
      return c.json(errorBody('EXPORT_NOT_READY', 'Selected export is not ready.'), 409);
    }

    try {
      const response = await streamMediaObject(
        makeBucket(c.env),
        variant.objectKey,
        c.req.raw,
        `${project.id}-${variant.targetLanguage}-dubbed.mp4`,
      );
      emitTelemetry(createTelemetry(c.env), {
        name: 'export_download',
        requestId: c.get('requestId'),
        actorId: userId,
        projectId,
        accessMode: 'owner',
        httpStatus: response.status,
        rangeRequest: Boolean(c.req.header('range')),
        status: response.status < 400 ? 'success' : 'rejected',
      });
      return response;
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) {
        return c.json(errorBody('EXPORT_OBJECT_NOT_FOUND', 'Selected export object not found.'), 404);
      }
      throw error;
    }
  });

  return routes;
}
