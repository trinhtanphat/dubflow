import type { AiBinding } from '../../cloudflare/ai';
import type { VoiceCapabilities, VoiceGenerateInput, VoiceProvider } from './types';
import { VoiceProviderError } from './types';

export type WorkersAIVoiceConfig = {
  model?: string;
  verifiedLanguages?: string[];
  voice?: string;
};

export class WorkersAIVoiceProvider implements VoiceProvider {
  constructor(private readonly ai: AiBinding, private readonly config: WorkersAIVoiceConfig = {}) {}

  capabilities(): VoiceCapabilities {
    return {
      provider: 'workers-ai',
      configured: Boolean(this.config.model),
      languages: this.config.verifiedLanguages ?? 'unknown',
      cloning: false,
      preview: Boolean(this.config.model && this.config.verifiedLanguages?.length),
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
    };
  }

  async generate(input: VoiceGenerateInput): Promise<unknown> {
    const verified = this.config.verifiedLanguages;
    if (!this.config.model || !verified?.includes(input.language)) {
      throw new VoiceProviderError('VOICE_LANGUAGE_UNVERIFIED', 'Requested voice language has not passed a live provider capability check.');
    }
    return this.ai.run(this.config.model, {
      text: input.text,
      ...(input.voice || this.config.voice ? { speaker: input.voice ?? this.config.voice } : {}),
    }, { returnRawResponse: true });
  }
}
