import { describe, expect, it } from 'vitest';
import { targetVoiceObjectKey } from '../src/services/voice/object-key';

describe('target voice object key', () => {
  it('keeps target language, segment and translation version in the PCM key', () => {
    expect(targetVoiceObjectKey('p1', 'vi', 's1', 3)).toBe('projects/p1/voices/vi/s1/3.pcm');
  });
});
