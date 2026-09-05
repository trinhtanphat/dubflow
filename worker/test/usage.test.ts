import { describe, expect, it } from 'vitest';

describe('Phase 3B usage credits', () => {
  it('converts normalized provider units into internal credits', async () => {
    const modulePath = '../src/domain/' + 'usage';
    const usage = await import(modulePath) as {
      creditsForUsage(kind: string, units: number): { credits: number; creditRate: number };
    };

    expect(usage.creditsForUsage('asr_audio_seconds', 60)).toEqual({ credits: 10, creditRate: 1 / 6 });
    expect(usage.creditsForUsage('translation_characters', 1000)).toEqual({ credits: 5, creditRate: 1 / 200 });
    expect(usage.creditsForUsage('tts_characters', 1000)).toEqual({ credits: 20, creditRate: 1 / 50 });
    expect(usage.creditsForUsage('render_seconds', 60)).toEqual({ credits: 2, creditRate: 1 / 30 });
  });

  it('rejects empty or non-finite billable usage', async () => {
    const modulePath = '../src/domain/' + 'usage';
    const usage = await import(modulePath) as {
      creditsForUsage(kind: string, units: number): { credits: number; creditRate: number };
    };

    for (const units of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => usage.creditsForUsage('asr_audio_seconds', units)).toThrow(/positive finite/i);
    }
  });
});
