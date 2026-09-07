import { Hono } from 'hono';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import type { Env } from '../env';
import { streamMediaObject, MediaObjectNotFoundError } from '../http/media-stream';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { verifyMediaSourceToken } from '../security/media-source-token';

export type MediaSourceRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
};

function sourceRequest(c: { req: { param(name: string): string; query(name: string): string | undefined } }) {
  const projectId = c.req.param('projectId');
  const objectKey = c.req.query('key') ?? '';
  const expires = Number(c.req.query('expires'));
  const signature = c.req.query('signature') ?? '';
  return { projectId, objectKey, expires, signature };
}

function signingSecret(env: Env): string {
  return env.MEDIA_SOURCE_SIGNING_SECRET?.trim() || '';
}

function readableBucket(c: { env: Env }): R2ReadableBucketLike {
  return {
    async head(key) {
      return c.env.MEDIA.head ? c.env.MEDIA.head(key) : null;
    },
    async get(key, options) {
      return c.env.MEDIA.get ? c.env.MEDIA.get(key, options) : null;
    },
  };
}

export function createMediaSourceRoutes(deps: MediaSourceRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));

  const authorize = async (c: any): Promise<{ projectId: string; objectKey: string } | Response> => {
    const { projectId, objectKey, expires, signature } = sourceRequest(c);
    const allowed = await verifyMediaSourceToken({
      secret: signingSecret(c.env),
      projectId,
      objectKey,
      expires,
      signature,
    });
    if (!allowed) return c.body(null, 403);

    const project = await makeProjects(c.env).getByIdForUser(projectId, getCurrentUserId());
    if (!project) return c.body(null, 404);
    if (!project.sourceObjectKey || project.sourceObjectKey !== objectKey) return c.body(null, 409);
    return { projectId, objectKey };
  };

  routes.on('HEAD', '/:projectId', async (c) => {
    const source = await authorize(c);
    if (source instanceof Response) return source;
    const object = await readableBucket(c).head?.(source.objectKey);
    if (!object) return c.body(null, 404);
    const headers = new Headers();
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(object.size));
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'video/mp4');
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    return new Response(null, { status: 200, headers });
  });

  routes.get('/:projectId', async (c) => {
    const source = await authorize(c);
    if (source instanceof Response) return source;
    try {
      return await streamMediaObject(readableBucket(c), source.objectKey, c.req.raw, 'source-media');
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) return c.body(null, 404);
      throw error;
    }
  });

  return routes;
}
