import { Hono } from 'hono';
import type { Env } from '../env';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { ProjectExportRepository } from '../db/project-exports';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { isTargetLanguage } from '../domain/language';
import { errorBody } from '../http/json';
import { MediaObjectNotFoundError, streamMediaObject } from '../http/media-stream';
import { createTelemetry, emitTelemetry } from '../observability/telemetry';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';

export type VisualExportMediaRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeExports?: (env: Env) => Pick<ProjectExportRepository, 'latestCompleted'>;
  makeBucket?: (env: Env) => R2ReadableBucketLike;
};

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

export function createVisualExportMediaRoutes(deps: VisualExportMediaRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeExports = deps.makeExports ?? ((env: Env) => new ProjectExportRepository(env.DB));
  const makeBucket = deps.makeBucket ?? readableBucket;

  routes.get('/:id/exports/:language/media', async (c, next) => {
    if (c.req.query('visualMode') !== 'lip_sync') return next();

    const output = c.req.query('output') ?? 'dubbed';
    if (output !== 'dubbed') {
      return c.json(errorBody('VISUAL_MODE_INVALID', 'Visual lip-sync is available only for dubbed video exports.'), 400);
    }

    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const targetLanguage = c.req.param('language');
    if (!isTargetLanguage(targetLanguage)) {
      return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Unsupported target language.'), 400);
    }

    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const attempt = await makeExports(c.env).latestCompleted(projectId, userId, targetLanguage, 'dubbed');
    const expectedObjectKey = attempt
      ? `projects/${projectId}/exports/${targetLanguage}/${attempt.id}.lipsync.mp4`
      : null;
    if (
      !attempt
      || attempt.lipSyncRequested !== true
      || attempt.lipSyncStatus !== 'completed'
      || !attempt.lipSyncObjectKey
      || attempt.lipSyncObjectKey !== expectedObjectKey
    ) {
      return c.json(errorBody('LIP_SYNC_NOT_READY', 'Visual lip-sync export is not completed.'), 409);
    }

    try {
      const response = await streamMediaObject(
        makeBucket(c.env),
        attempt.lipSyncObjectKey,
        c.req.raw,
        `${project.id}-${targetLanguage}-lipsync.mp4`,
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
        return c.json(errorBody('EXPORT_OBJECT_NOT_FOUND', 'Visual lip-sync export object not found.'), 404);
      }
      throw error;
    }
  });

  return routes;
}
