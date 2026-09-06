export type CreateInstantCloneInput = {
  name: string;
  sample: Blob;
};

export type CreateInstantCloneResult = {
  providerVoiceId: string;
  requiresVerification: boolean;
};

export interface VoiceCloneProvider {
  createInstantClone(input: CreateInstantCloneInput): Promise<CreateInstantCloneResult>;
  deleteClone(providerVoiceId: string): Promise<void>;
}

export class VoiceCloneProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'VoiceCloneProviderError';
  }
}

export class VoiceCloneEnrollmentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'VoiceCloneEnrollmentError';
  }
}
