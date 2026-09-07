import { Hono } from 'hono';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { streamMediaObject, MediaObjectNotFoundError } from '../http/media-stream';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { verifyStreamSourceToken } from '../security/stream-source-token';

function sourceRequest(c: { req: { param(name: string): string; query(name: string): string | undefined } }) {
  const projectId = c.req.param('projectId');
  const objectKey = c.req.query('key') ?? '';
  const expires = Number(c.req.query('expires'));
  const signature = c.req.query('signature') ?? '';
  return { projectId, objectKey, expires, signature };
}

async function authorize(c: any): Promise<{ projectId: string; objectKey: string } | null> {
  const { projectId, objectKey, expires, signature } = sourceRequest(c);
  const allowed = await verifyStreamSourceToken({
    secret: c.env.STREAM_SOURCE_SIGNING_SECRET ?? '',
    projectId,
    objectKey,
    expires,
    signature,
  });
  return allowed ? { projectId, objectKey } : null;
}

function readableBucket(c: any): R2ReadableBucketLike {
  return {
    async head(key) {
      return c.env.MEDIA.head ? c.env.MEDIA.head(key) : null;
    },
    async get(key, options) {
      return c.env.MEDIA.get ? c.env.MEDIA.get(key, options) : null;
    },
  };
}

export function createStreamSourceRoutes() {
  const routes = new Hono<WorkerHonoEnv>();

  routes.on('HEAD', '/:projectId', async (c) => {
    const source = await authorize(c);
    if (!source) return c.body(null, 403);
    const object = await readableBucket(c).head?.(source.objectKey);
    if (!object) return c.body(null, 404);
    const headers = new Headers();
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(object.size));
    headers.set('Content-Range', `bytes 0-${Math.max(0, object.size - 1)}/${object.size}`);
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'video/mp4');
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    return new Response(null, { status: 200, headers });
  });

  routes.get('/:projectId', async (c) => {
    const source = await authorize(c);
    if (!source) return c.body(null, 403);
    try {
      return await streamMediaObject(readableBucket(c), source.objectKey, c.req.raw, 'source-media');
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) return c.body(null, 404);
      throw error;
    }
  });

  return routes;
}
