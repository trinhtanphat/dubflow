import { describe, expect, it } from 'vitest';
import { resolveSegmentSpeakerVoice } from './ScriptInspector';

const speakers = [
  { id: 'speaker-1', name: 'Nữ chính', label: 'SPEAKER_00', share: 55, voiceProvider: 'elevenlabs', voiceId: ' voice-heroine ' },
  { id: 'speaker-2', name: 'Nam chính', label: 'SPEAKER_01', share: 45, voiceProvider: 'elevenlabs', voiceId: 'voice-hero' },
];

describe('segment speaker voice resolution', () => {
  it('returns the assigned ElevenLabs voice for the segment speaker', () => {
    expect(resolveSegmentSpeakerVoice({ speakerId: 'speaker-1' }, speakers)).toBe('voice-heroine');
  });

  it('returns undefined for unassigned or unsupported speaker voices', () => {
    expect(resolveSegmentSpeakerVoice({ speakerId: 'missing' }, speakers)).toBeUndefined();
    expect(resolveSegmentSpeakerVoice(
      { speakerId: 'speaker-x' },
      [{ id: 'speaker-x', name: 'X', label: 'X', share: 1, voiceProvider: 'other', voiceId: 'voice-x' }],
    )).toBeUndefined();
  });
});
