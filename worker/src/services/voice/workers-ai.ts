import type { AiBinding } from '../../cloudflare/ai';
import type { VoiceCapabilities, VoiceGenerateInput, VoiceProvider } from './types';
import { VoiceProviderError } from './types';

export type WorkersAIVoiceConfig = {
  model?: string;
  verifiedLanguages?: string[];
  voice?: string;
  provider?: string;
};

type GrokTtsOutput = {
  audio?: unknown;
  result?: {
    audio?: unknown;
  };
};

function grokAudioUrl(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const value = output as GrokTtsOutput;
  const candidate = value.result?.audio ?? value.audio;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

export class WorkersAIVoiceProvider implements VoiceProvider {
  constructor(private readonly ai: AiBinding, private readonly config: WorkersAIVoiceConfig = {}) {}

  capabilities(): VoiceCapabilities {
    return {
      provider: this.config.provider ?? 'workers-ai',
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

    if (this.config.model === 'xai/grok-tts') {
      if (input.outputFormat !== 'pcm_24000') {
        throw new VoiceProviderError('VOICE_OUTPUT_UNSUPPORTED', 'Grok TTS production fallback is qualified for raw 24 kHz PCM only.');
      }
      const voiceId = (input.voice ?? this.config.voice ?? '').trim();
      if (!voiceId) {
        throw new VoiceProviderError('VOICE_PROVIDER_UNCONFIGURED', 'Grok TTS requires a configured voice id.');
      }
      const output = await this.ai.run(this.config.model, {
        text: input.text,
        language: input.language,
        voice_id: voiceId,
        output_format: { codec: 'pcm', sample_rate: 24000 },
      });
      const audioUrl = grokAudioUrl(output);
      if (!audioUrl) {
        throw new VoiceProviderError('VOICE_PROVIDER_FAILED', 'Grok TTS did not return an audio URL.');
      }
      const response = await fetch(audioUrl);
      if (!response.ok) {
        throw new VoiceProviderError('VOICE_PROVIDER_FAILED', `Grok TTS audio download failed (${response.status}).`);
      }
      return response;
    }

    return this.ai.run(this.config.model, {
      text: input.text,
      ...(input.voice || this.config.voice ? { speaker: input.voice ?? this.config.voice } : {}),
    }, { returnRawResponse: true });
  }
}
