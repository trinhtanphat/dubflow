import { afterEach, describe, expect, it, vi } from 'vitest';

const summary = {
  allocatedCredits: 50_000,
  usedCredits: 37,
  remainingCredits: 49_963,
  overageCredits: 0,
  totals: [
    { kind: 'asr_audio_seconds', units: 60, credits: 10 },
    { kind: 'translation_characters', units: 1_400, credits: 7 },
    { kind: 'tts_characters', units: 1_000, credits: 20 },
  ],
  providers: [
    { provider: 'deepgram-nova-3', kind: 'asr_audio_seconds', units: 60, credits: 10 },
    { provider: 'workers-ai', kind: 'translation_characters', units: 1_000, credits: 5 },
    { provider: 'google', kind: 'translation_characters', units: 400, credits: 2 },
    { provider: 'elevenlabs', kind: 'tts_characters', units: 1_000, credits: 20 },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('Phase 3B dashboard usage API', () => {
  it('loads the typed current-user usage summary from the canonical endpoint', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json(summary);
    });
    const modulePath = './' + 'usageApi';
    const { fetchUsageSummary } = await import(modulePath) as {
      fetchUsageSummary(): Promise<typeof summary>;
    };

    await expect(fetchUsageSummary()).resolves.toEqual(summary);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toContain('/api/usage/summary');
  });

  it('surfaces API errors instead of returning invented zero usage', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ code: 'USAGE_SUMMARY_FAILED', message: 'ledger unavailable' }, { status: 500 }));
    const modulePath = './' + 'usageApi';
    const { fetchUsageSummary } = await import(modulePath) as {
      fetchUsageSummary(): Promise<typeof summary>;
    };

    await expect(fetchUsageSummary()).rejects.toThrow(/ledger unavailable|usage/i);
  });
});
