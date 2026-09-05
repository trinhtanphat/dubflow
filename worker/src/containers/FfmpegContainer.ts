import { Container } from '@cloudflare/containers';
import type { Env } from '../env';

const OBJECT_PATH = '/objects/';

function objectKeyFromRequest(request: Request): string | null {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(OBJECT_PATH)) return null;
  try {
    const key = decodeURIComponent(pathname.slice(OBJECT_PATH.length));
    return key && !key.includes('..') ? key : null;
  } catch {
    return null;
  }
}

export class FfmpegContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = false;
  allowedHosts = ['media.r2'];
}

FfmpegContainer.outboundByHost = {
  'media.r2': async (request: Request, env: Env) => {
    const key = objectKeyFromRequest(request);
    if (!key) return new Response('Invalid R2 object path.', { status: 400 });

    if (request.method === 'GET') {
      if (!env.MEDIA.get) return new Response('R2 get binding unavailable.', { status: 503 });
      const object = await env.MEDIA.get(key);
      if (!object) return new Response('Not found.', { status: 404 });
      return new Response(object.body, {
        status: 200,
        headers: {
          'content-length': String(object.size),
          'content-type': 'application/octet-stream',
        },
      });
    }

    if (request.method === 'PUT') {
      if (!request.body) return new Response('Request body required.', { status: 400 });
      if (!env.MEDIA.put) return new Response('R2 put binding unavailable.', { status: 503 });
      const object = await env.MEDIA.put(key, request.body);
      return Response.json({ key: object.key, size: object.size });
    }

    return new Response('Method not allowed.', { status: 405 });
  },
};
