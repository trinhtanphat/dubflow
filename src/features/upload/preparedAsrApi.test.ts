import { describe, expect, it } from 'vitest';
import { completePreparedAsrUpload, uploadPreparedAsrChunk } from './preparedAsrApi';

describe('prepared ASR upload API', () => {
  it('uploads one WAV chunk with generation-bound metadata and no client object key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ index: 0, objectKey: 'projects/p1/asr/source-2/chunk-0.wav', offsetMs: 0, durationMs: 300_000, sizeBytes: 48 });
    };

    const result = await uploadPreparedAsrChunk('p1', 2, {
      index: 0,
      offsetMs: 0,
      durationMs: 300_000,
      wav: new ArrayBuffer(48),
    }, fetcher as typeof fetch);

    const request = calls[0];
    const url = new URL(request.url, 'https://local.test');
    expect(url.pathname).toBe('/api/projects/p1/uploads/asr/chunks/0');
    expect(url.searchParams.get('sourceGeneration')).toBe('2');
    expect(url.searchParams.get('offsetMs')).toBe('0');
    expect(url.searchParams.get('durationMs')).toBe('300000');
    expect(url.searchParams.has('objectKey')).toBe(false);
    expect(request.init?.method).toBe('PUT');
    expect(request.init?.headers).toMatchObject({ 'content-type': 'audio/wav' });
    expect(result.objectKey).toBe('projects/p1/asr/source-2/chunk-0.wav');
  });

  it('completes only ordered descriptor metadata and lets the server derive canonical keys', async () => {
    let requestBody: any;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        version: 1,
        projectId: 'p1',
        sourceObjectKey: 'projects/p1/source/source.mp4',
        sourceGeneration: 2,
        sampleRate: 16000,
        channels: 1,
        sampleFormat: 's16',
        container: 'wav',
        durationMs: 310_000,
        chunks: [],
      });
    };

    await completePreparedAsrUpload('p1', 2, 310_000, [
      { index: 0, objectKey: 'projects/p1/asr/source-2/chunk-0.wav', offsetMs: 0, durationMs: 300_000, sizeBytes: 48 },
      { index: 1, objectKey: 'projects/p1/asr/source-2/chunk-1.wav', offsetMs: 300_000, durationMs: 10_000, sizeBytes: 48 },
    ], fetcher as typeof fetch);

    expect(requestBody).toEqual({
      sourceGeneration: 2,
      durationMs: 310_000,
      chunks: [
        { index: 0, offsetMs: 0, durationMs: 300_000, sizeBytes: 48 },
        { index: 1, offsetMs: 300_000, durationMs: 10_000, sizeBytes: 48 },
      ],
    });
  });
});
