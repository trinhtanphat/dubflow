import { describe, expect, it } from 'vitest';
import { clientVoiceArtifactsComplete } from '../src/routes/export';
import type { SegmentTranslation } from '../src/db/segment-translations';

function variant(overrides: Partial<SegmentTranslation> = {}): SegmentTranslation {
  return {
    segmentId: 's1',
    projectId: 'p1',
    targetLanguage: 'vi',
    translatedText: 'Xin chào',
    translationEngine: 'workers-ai',
    translationStatus: 'completed',
    translationContextRevision: null,
    voiceStatus: 'completed',
    dubbedObjectKey: 'projects/p1/voices/vi/s1/3.pcm',
    version: 3,
    ...overrides,
  };
}

describe('client PCM export cache admission', () => {
  it('accepts only a complete exact-version target cache', () => {
    expect(clientVoiceArtifactsComplete('p1', 'vi', [{ id: 's1' }], [variant()])).toBe(true);
  });

  it('rejects stale, missing, duplicate and incomplete voice artifacts', () => {
    expect(clientVoiceArtifactsComplete('p1', 'vi', [{ id: 's1' }], [
      variant({ dubbedObjectKey: 'projects/p1/voices/vi/s1/2.pcm' }),
    ])).toBe(false);
    expect(clientVoiceArtifactsComplete('p1', 'vi', [{ id: 's1' }], [
      variant({ voiceStatus: 'pending', dubbedObjectKey: null }),
    ])).toBe(false);
    expect(clientVoiceArtifactsComplete('p1', 'vi', [{ id: 's1' }], [variant(), variant()])).toBe(false);
    expect(clientVoiceArtifactsComplete('p1', 'vi', [{ id: 's1' }], [
      variant({ translationStatus: 'pending' }),
    ])).toBe(false);
  });

  it('rejects a cache for the wrong target language or an invalid translation version', () => {
    expect(clientVoiceArtifactsComplete('p1', 'en', [{ id: 's1' }], [variant()])).toBe(false);
    expect(clientVoiceArtifactsComplete('p1', 'vi', [{ id: 's1' }], [variant({ version: 0 })])).toBe(false);
  });
});
