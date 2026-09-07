import { describe, expect, it } from 'vitest';
import { DeepgramNova3AsrProvider } from '../src/services/asr/deepgram';

describe('Deepgram remote media ASR', () => {
  it('transcribes a remote Stream audio URL without buffering media in the Worker', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({
        results: {
          channels: [{ alternatives: [{ transcript: 'hello world' }] }],
          utterances: [{ start: 0, end: 1.5, transcript: 'hello world', speaker: 0 }],
        },
      });
    };
    const provider = new DeepgramNova3AsrProvider('dg-secret', fetcher);

    const result = await provider.transcribeUrl('https://videodelivery.net/audio-source.m4a', { sourceLanguage: 'en' });

    expect(result.segments).toEqual([
      { startMs: 0, endMs: 1500, text: 'hello world', speakerIndex: 0 },
    ]);
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.init?.headers).toMatchObject({
      Authorization: 'Token dg-secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(request.init?.body))).toEqual({ url: 'https://videodelivery.net/audio-source.m4a' });
  });
});
