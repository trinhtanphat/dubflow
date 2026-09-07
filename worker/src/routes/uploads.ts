import { Hono } from 'hono';
import type { Env } from '../env';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { UploadInputError } from '../domain/upload';
import { UploadService, UploadServiceError } from '../services/uploads';
import { ProjectRepository } from '../db/projects';
import { errorBody } from '../http/json';

export type UploadRouteDeps = {
  makeService?: (env: Env) => UploadService;
};

function uploadError(error: unknown) {
  if (error instanceof UploadInputError || error instanceof UploadServiceError) {
    const status = error.code === 'PROJECT_NOT_FOUND' ? 404 : 400;
    return { status, body: errorBody(error.code, error.message) } as const;
  }
  return { status: 500, body: errorBody('UPLOAD_FAILED', 'Upload operation failed.') } as const;
}

export function createUploadRoutes(deps: UploadRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const makeService = deps.makeService ?? ((env: Env) => new UploadService(env.MEDIA, new ProjectRepository(env.DB)));

  routes.post('/:id/uploads', async (c) => {
    const projectId = c.req.param('id');
    const userId = getCurrentUserId();
    try {
      const service = makeService(c.env);
      const input = await service.validateBegin(projectId, userId, await c.req.json());
      const rateLimited = await enforceRateLimit(c, 'upload', userId, projectId);
      if (rateLimited) return rateLimited;
      return c.json(await service.beginValidated(projectId, input), 201);
    } catch (error) {
      const result = uploadError(error);
      return c.json(result.body, result.status);
    }
  });

  routes.put('/:id/uploads/:uploadId/parts/:partNumber', async (c) => {
    try {
      const objectKey = new URL(c.req.raw.url).searchParams.get('objectKey') ?? '';
      const body = c.req.raw.body;
      if (!body) return c.json(errorBody('UPLOAD_BODY_REQUIRED', 'Upload part body is required.'), 400);
      const service = makeService(c.env);
      const part = await service.uploadPart(
        c.req.param('id'), getCurrentUserId(), c.req.param('uploadId'), objectKey,
        Number(c.req.param('partNumber')), body,
      );
      return c.json(part);
    } catch (error) {
      const result = uploadError(error);
      return c.json(result.body, result.status);
    }
  });

  routes.post('/:id/uploads/:uploadId/complete', async (c) => {
    try {
      const input = await c.req.json() as { objectKey?: string; parts?: { partNumber: number; etag: string }[] };
      const service = makeService(c.env);
      return c.json(await service.complete(
        c.req.param('id'), getCurrentUserId(), c.req.param('uploadId'), input.objectKey ?? '', input.parts ?? [],
      ));
    } catch (error) {
      const result = uploadError(error);
      return c.json(result.body, result.status);
    }
  });

  return routes;
}
