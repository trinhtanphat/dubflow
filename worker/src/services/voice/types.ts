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

export type VoiceOutputFormat = 'mp3_44100_128' | 'pcm_24000';

export type VoiceGenerateInput = {
  text: string;
  language: string;
  voice?: string;
  outputFormat?: VoiceOutputFormat;
};

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
