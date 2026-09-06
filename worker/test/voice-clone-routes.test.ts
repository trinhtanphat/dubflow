import { describe, expect, it } from 'vitest';
import {
  parseVoiceCloneCreatePayload,
  assertVoiceCloneAssignable,
} from '../src/routes/voice-clones';

describe('voice clone route contracts', () => {
  it('requires the exact affirmative consent contract', () => {
    expect(() => parseVoiceCloneCreatePayload({ name: 'Narrator' })).toThrowError(/consent/i);
    expect(() => parseVoiceCloneCreatePayload({
      name: 'Narrator',
      consentVersion: 'voice-clone-consent-v1',
      consentAcknowledged: false,
    })).toThrowError(/consent/i);
    expect(parseVoiceCloneCreatePayload({
      name: 'Narrator',
      consentVersion: 'voice-clone-consent-v1',
      consentAcknowledged: true,
    })).toEqual({ name: 'Narrator', consentVersion: 'voice-clone-consent-v1' });
  });

  it('allows assignment only for ready clones', () => {
    expect(() => assertVoiceCloneAssignable({ status: 'verification_required' } as any)).toThrowError(/ready/i);
    expect(() => assertVoiceCloneAssignable({ status: 'failed' } as any)).toThrowError(/ready/i);
    expect(() => assertVoiceCloneAssignable({ status: 'ready' } as any)).not.toThrow();
  });
});
