import { Container } from '@cloudflare/containers';
import type { Env } from '../env';

const OBJECT_PATH = '/objects/';
const ELEVENLABS_STEM_PATH = '/v1/music/stem-separation';

export const FFMPEG_ALLOWED_HOSTS = ['media.r2', 'api.elevenlabs.io'] as const;
export const FFMPEG_INTERCEPT_HTTPS = true;

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

async function elevenLabsStemRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== ELEVENLABS_STEM_PATH) {
    return new Response('Provider request not allowed.', { status: 403 });
  }
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return new Response('Stem separation provider unavailable.', { status: 503 });

  const headers = new Headers(request.headers);
  headers.set('xi-api-key', apiKey);
  return fetch(new Request(request, { headers }));
}

export class FfmpegContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = false;
  interceptHttps = FFMPEG_INTERCEPT_HTTPS;
  allowedHosts = [...FFMPEG_ALLOWED_HOSTS];
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
  'api.elevenlabs.io': elevenLabsStemRequest,
};
