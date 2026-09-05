import { Hono } from 'hono';
import type { Env } from '../env';
import type { ProjectStore } from '../db/projects';
import { ProjectRepository } from '../db/projects';
import type { R2BucketLike } from '../cloudflare/r2';
import { errorBody } from '../http/json';
import { getCurrentUserId } from '../security/current-user';
import { parseByteRange } from '../services/media';

export type MediaStoreFactory = (env: Env) => ProjectStore;
export type MediaBucketFactory = (env: Env) => R2BucketLike;

export function createMediaRoutes(
  makeStore: MediaStoreFactory = (env) => new ProjectRepository(env.DB),
  makeBucket: MediaBucketFactory = (env) => env.MEDIA,
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/:id/media', async (c) => {
    const project = await makeStore(c.env).getByIdForUser(c.req.param('id'), getCurrentUserId());
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!project.sourceObjectKey) return c.json(errorBody('MEDIA_NOT_READY', 'Source media is not ready.'), 409);

    const rangeHeader = c.req.header('range') ?? null;
    const knownSize = project.sizeBytes ?? 0;
    const parsedRange = rangeHeader ? parseByteRange(rangeHeader, knownSize) : null;
    if (rangeHeader && !parsedRange) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${knownSize}`, 'Accept-Ranges': 'bytes' },
      });
    }

    const bucket = makeBucket(c.env);
    const object = await bucket.get(
      project.sourceObjectKey,
      parsedRange ? { range: { offset: parsedRange.offset, length: parsedRange.length } } : undefined,
    );
    if (!object) return c.json(errorBody('MEDIA_OBJECT_NOT_FOUND', 'Source media object not found.'), 404);

    const totalSize = knownSize > 0 ? knownSize : object.size;
    const headers = new Headers();
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
    headers.set('Content-Length', String(parsedRange?.length ?? object.size));
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    if (parsedRange) headers.set('Content-Range', `bytes ${parsedRange.offset}-${parsedRange.end}/${totalSize}`);

    return new Response(object.body, { status: parsedRange ? 206 : 200, headers });
  });

  return routes;
}
