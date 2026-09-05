export type VoiceCapabilities = { languages: string[] | 'unknown'; cloning: false };
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
