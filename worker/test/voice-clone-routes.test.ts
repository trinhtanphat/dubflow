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

  it('allows assignment only for ready clones with a provider voice id', () => {
    expect(() => assertVoiceCloneAssignable({ status: 'verification_required', providerVoiceId: 'voice-1' })).toThrowError(/ready/i);
    expect(() => assertVoiceCloneAssignable({ status: 'failed', providerVoiceId: 'voice-1' })).toThrowError(/ready/i);
    expect(() => assertVoiceCloneAssignable({ status: 'ready', providerVoiceId: null })).toThrowError(/ready/i);
    expect(() => assertVoiceCloneAssignable({ status: 'ready', providerVoiceId: 'voice-1' })).not.toThrow();
  });
});
