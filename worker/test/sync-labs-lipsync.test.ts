import { describe, expect, it, vi } from 'vitest';

const VIDEO_URL = 'https://yupvox.qs3d.site/api/provider-media/video-grant?token=video-secret';
const AUDIO_URL = 'https://yupvox.qs3d.site/api/provider-media/audio-grant?token=audio-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Sync Labs visual lip-sync provider', () => {
  it('is unavailable without an API key and fails before network work', async () => {
    const modulePath = '../src/services/lipsync/sync-labs';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const fetchImpl = vi.fn();
    const provider = new loaded.SyncLabsLipSyncProvider({ apiKey: undefined, fetchImpl });
    expect(provider.id).toBe('sync-labs');
    expect(provider.available).toBe(false);
    await expect(provider.render({ videoUrl: VIDEO_URL, audioUrl: AUDIO_URL })).rejects.toMatchObject({
      code: 'LIP_SYNC_UNAVAILABLE',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('submits exact video/audio URL inputs with sync-3 and polls wait=true through PROCESSING to COMPLETED', async () => {
    const modulePath = '../src/services/lipsync/sync-labs';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'PENDING', outputUrl: '' }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'PROCESSING', outputUrl: '' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'COMPLETED', outputUrl: 'https://cdn.sync.so/output.mp4', outputDuration: 12.5 }));

    const provider = new loaded.SyncLabsLipSyncProvider({ apiKey: 'secret-key', fetchImpl, maxPollAttempts: 4 });
    expect(provider.available).toBe(true);
    const result = await provider.render({ videoUrl: VIDEO_URL, audioUrl: AUDIO_URL });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.sync.so/v2/generate');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get('x-api-key')).toBe('secret-key');
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({
      model: 'sync-3',
      input: [
        { type: 'video', url: VIDEO_URL },
        { type: 'audio', url: AUDIO_URL },
      ],
    });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.sync.so/v2/generate/job-1?wait=true');
    expect(fetchImpl.mock.calls[2][0]).toBe('https://api.sync.so/v2/generate/job-1?wait=true');
    expect(result).toEqual({
      provider: 'sync-labs',
      providerJobId: 'job-1',
      outputUrl: 'https://cdn.sync.so/output.mp4',
      outputDurationSeconds: 12.5,
    });
  });

  it.each(['FAILED', 'REJECTED'])('normalizes terminal %s status to LIP_SYNC_FAILED', async (status) => {
    const modulePath = '../src/services/lipsync/sync-labs';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'job-2', status, error: 'provider rejected media' }, 201));
    const provider = new loaded.SyncLabsLipSyncProvider({ apiKey: 'secret-key', fetchImpl });
    await expect(provider.render({ videoUrl: VIDEO_URL, audioUrl: AUDIO_URL })).rejects.toMatchObject({
      code: 'LIP_SYNC_FAILED',
    });
  });

  it('rejects malformed provider responses with LIP_SYNC_RESPONSE_INVALID', async () => {
    const modulePath = '../src/services/lipsync/sync-labs';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 'PENDING' }, 201));
    const provider = new loaded.SyncLabsLipSyncProvider({ apiKey: 'secret-key', fetchImpl });
    await expect(provider.render({ videoUrl: VIDEO_URL, audioUrl: AUDIO_URL })).rejects.toMatchObject({
      code: 'LIP_SYNC_RESPONSE_INVALID',
    });
  });

  it('bounds long polling and returns LIP_SYNC_TIMEOUT instead of polling forever', async () => {
    const modulePath = '../src/services/lipsync/sync-labs';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'job-3', status: 'PENDING', outputUrl: '' }, 201))
      .mockResolvedValue(jsonResponse({ id: 'job-3', status: 'PROCESSING', outputUrl: '' }));
    const provider = new loaded.SyncLabsLipSyncProvider({ apiKey: 'secret-key', fetchImpl, maxPollAttempts: 2 });

    await expect(provider.render({ videoUrl: VIDEO_URL, audioUrl: AUDIO_URL })).rejects.toMatchObject({
      code: 'LIP_SYNC_TIMEOUT',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
