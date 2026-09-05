import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUsageSummary, type UsageSummaryResponse } from './usageApi';

afterEach(() => vi.unstubAllGlobals());

describe('usage API', () => {
  it('loads canonical seconds-based account usage without converting transport units', async () => {
    const calls: string[] = [];
    const payload: UsageSummaryResponse = {
      creditBalance: 50000,
      totals: {
        asrAudioSeconds: 90,
        translationCharacters: 1200,
        ttsAudioSeconds: 35.5,
        renderSeconds: 150,
      },
      providers: {
        elevenlabs: {
          asrAudioSeconds: 0,
          translationCharacters: 0,
          ttsAudioSeconds: 35.5,
          renderSeconds: 0,
        },
      },
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json(payload);
    });

    await expect(getUsageSummary()).resolves.toEqual(payload);
    expect(calls).toEqual(['/api/usage']);
  });
});
