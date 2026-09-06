export type VoiceCloneEnrollmentCapability = {
  provider: 'elevenlabs';
  mode: 'ivc';
  available: boolean;
};

export type VoiceCapabilities = {
  provider?: string;
  configured?: boolean;
  languages: string[] | 'unknown';
  cloning: boolean;
  preview?: boolean;
  cloneEnrollment: VoiceCloneEnrollmentCapability;
};

export type VoiceGenerateInput = { text: string; language: string; voice?: string };

export interface VoiceProvider {
  capabilities(): VoiceCapabilities;
  generate(input: VoiceGenerateInput): Promise<unknown>;
}

export class VoiceProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}
