import { SUPPORTED_TARGET_LANGUAGES, isTargetLanguage, type TargetLanguage } from '../../domain/target-language';
import type { VoiceGenerateInput, VoiceProvider } from './types';
import { VoiceProviderError } from './types';

export type ElevenLabsVoiceConfig = {
  defaultVoiceId?: string;
  modelId?: string;
};

export type ElevenLabsVoiceCapabilities = {
  provider: 'elevenlabs';
  configured: boolean;
  languages: TargetLanguage[];
  cloning: boolean;
  preview: boolean;
  cloneEnrollment: {
    provider: 'elevenlabs';
    mode: 'ivc';
    available: boolean;
  };
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_MODEL = 'eleven_multilingual_v2';

export class ElevenLabsVoiceProvider implements VoiceProvider {
  constructor(
    private readonly apiKey: string,
    private readonly config: ElevenLabsVoiceConfig = {},
    private readonly fetcher: FetchLike = fetch,
  ) {}

  capabilities(): ElevenLabsVoiceCapabilities {
    const apiConfigured = Boolean(this.apiKey.trim());
    const previewConfigured = Boolean(apiConfigured && this.config.defaultVoiceId?.trim());
    return {
      provider: 'elevenlabs',
      configured: previewConfigured,
      languages: [...SUPPORTED_TARGET_LANGUAGES],
      cloning: apiConfigured,
      preview: previewConfigured,
      cloneEnrollment: {
        provider: 'elevenlabs',
        mode: 'ivc',
        available: apiConfigured,
      },
    };
  }

  async generate(input: VoiceGenerateInput): Promise<Response> {
    const apiKey = this.apiKey.trim();
    const voiceId = (input.voice ?? this.config.defaultVoiceId ?? '').trim();
    if (!apiKey || !voiceId) {
      throw new VoiceProviderError('VOICE_PROVIDER_UNCONFIGURED', 'ElevenLabs API key and voice id are required before voice generation can run.');
    }
    if (!isTargetLanguage(input.language)) {
      throw new VoiceProviderError('VOICE_LANGUAGE_UNSUPPORTED', 'Voice target language is outside the YupVox bounded target set.');
    }

    const response = await this.fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: input.text,
        model_id: this.config.modelId ?? DEFAULT_MODEL,
        language_code: input.language,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new VoiceProviderError('VOICE_PROVIDER_FAILED', `ElevenLabs speech generation failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`);
    }
    return response;
  }
}
