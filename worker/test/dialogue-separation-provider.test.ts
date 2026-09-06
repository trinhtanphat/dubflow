import { describe, expect, it } from 'vitest';
import { parseDubbedAudioMode } from '../src/domain/audio-mode';
import { UnavailableDialogueSeparationProvider } from '../src/services/separation/unavailable';

describe('Phase 4D audio mode and dialogue separation provider boundary', () => {
  it('parses only the three canonical dubbed audio modes and defaults omitted input', () => {
    expect(parseDubbedAudioMode(undefined)).toBe('dubbed_only');
    expect(parseDubbedAudioMode('dubbed_only')).toBe('dubbed_only');
    expect(parseDubbedAudioMode('duck_original')).toBe('duck_original');
    expect(parseDubbedAudioMode('separated_background')).toBe('separated_background');
    expect(parseDubbedAudioMode('bad')).toBeNull();
    expect(parseDubbedAudioMode(null)).toBeNull();
  });

  it('reports production separation as explicitly unavailable instead of pretending a provider exists', async () => {
    const provider = new UnavailableDialogueSeparationProvider();
    await expect(provider.capabilities()).resolves.toEqual({
      configured: false,
      provider: null,
      backgroundStem: false,
      dialogueStem: false,
      qualification: 'unavailable',
    });
  });

  it('fails closed when separation is requested from the unavailable provider', async () => {
    const provider = new UnavailableDialogueSeparationProvider();
    await expect(provider.separate({
      projectId: 'p1',
      sourceObjectKey: 'projects/p1/source/source.mp4',
      sourceGeneration: 1,
      durationMs: 120000,
    })).rejects.toMatchObject({
      name: 'DialogueSeparationError',
      code: 'DIALOGUE_SEPARATION_UNAVAILABLE',
    });
  });
});
