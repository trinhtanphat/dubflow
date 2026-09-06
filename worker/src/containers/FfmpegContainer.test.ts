import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { FFMPEG_ALLOWED_HOSTS, FFMPEG_INTERCEPT_HTTPS, FfmpegContainer } from './FfmpegContainer';

afterEach(() => vi.unstubAllGlobals());

function elevenLabsHandler() {
  const handler = FfmpegContainer.outboundByHost?.['api.elevenlabs.io'];
  expect(typeof handler).toBe('function');
  if (!handler) throw new Error('ElevenLabs outbound handler is not configured.');
  return handler;
}

function handlerContext<T extends (...args: any[]) => unknown>(handler: T): Parameters<T>[2] {
  return { containerId: 'phase4d-test' } as Parameters<T>[2];
}

describe('FfmpegContainer provider egress', () => {
  it('allows and intercepts the exact ElevenLabs API host', () => {
    expect(FFMPEG_ALLOWED_HOSTS).toEqual(['media.r2', 'api.elevenlabs.io']);
    expect(FFMPEG_INTERCEPT_HTTPS).toBe(true);
  });

  it('injects xi-api-key only inside the Worker outbound handler', async () => {
    const forwarded = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', forwarded);
    const handler = elevenLabsHandler();

    await handler(
      new Request('https://api.elevenlabs.io/v1/music/stem-separation', { method: 'POST', body: 'body' }),
      { ELEVENLABS_API_KEY: 'worker-secret' } as Env,
      handlerContext(handler),
    );

    const request = forwarded.mock.calls[0]?.[0] as Request;
    expect(request.headers.get('xi-api-key')).toBe('worker-secret');
  });

  it('denies provider paths outside stem separation and fails closed without the secret', async () => {
    const forwarded = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', forwarded);
    const handler = elevenLabsHandler();
    const ctx = handlerContext(handler);

    const denied = await handler(
      new Request('https://api.elevenlabs.io/v1/voices', { method: 'GET' }),
      { ELEVENLABS_API_KEY: 'worker-secret' } as Env,
      ctx,
    );
    expect(denied.status).toBe(403);

    const unavailable = await handler(
      new Request('https://api.elevenlabs.io/v1/music/stem-separation', { method: 'POST', body: 'body' }),
      {} as Env,
      ctx,
    );
    expect(unavailable.status).toBe(503);
    expect(forwarded).not.toHaveBeenCalled();
  });
});
