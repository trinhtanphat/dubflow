import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { FfmpegContainer } from './FfmpegContainer';

afterEach(() => vi.unstubAllGlobals());

describe('FfmpegContainer provider egress', () => {
  it('allows and intercepts the exact ElevenLabs API host', () => {
    expect(FfmpegContainer.allowedHosts).toContain('api.elevenlabs.io');
    expect(FfmpegContainer.interceptHttps).toBe(true);
  });

  it('injects xi-api-key only inside the Worker outbound handler', async () => {
    const forwarded = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', forwarded);
    const handler = FfmpegContainer.outboundByHost['api.elevenlabs.io'];
    expect(typeof handler).toBe('function');

    await handler(
      new Request('https://api.elevenlabs.io/v1/music/stem-separation', { method: 'POST', body: 'body' }),
      { ELEVENLABS_API_KEY: 'worker-secret' } as Env,
    );

    const request = forwarded.mock.calls[0]?.[0] as Request;
    expect(request.headers.get('xi-api-key')).toBe('worker-secret');
  });
});
