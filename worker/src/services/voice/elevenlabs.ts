import type { VoiceGenerateInput, VoiceProvider } from './types';
import { VoiceProviderError } from './types';

export type ElevenLabsVoiceConfig = {
  defaultVoiceId?: string;
  modelId?: string;
};

export type ElevenLabsVoiceCapabilities = {
  provider: 'elevenlabs';
  configured: boolean;
  languages: ['vi'];
  cloning: true;
  preview: boolean;
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
    const configured = Boolean(this.apiKey.trim() && this.config.defaultVoiceId?.trim());
    return {
      provider: 'elevenlabs',
      configured,
      languages: ['vi'],
      cloning: true,
      preview: configured,
    };
  }

  async generate(input: VoiceGenerateInput): Promise<Response> {
    const apiKey = this.apiKey.trim();
    const voiceId = (input.voice ?? this.config.defaultVoiceId ?? '').trim();
    if (!apiKey || !voiceId) {
      throw new VoiceProviderError('VOICE_PROVIDER_UNCONFIGURED', 'ElevenLabs API key and voice id are required before voice preview can run.');
    }
    if (input.language !== 'vi') {
      throw new VoiceProviderError('VOICE_LANGUAGE_UNVERIFIED', 'This YupVox ElevenLabs integration is currently qualified for Vietnamese dubbing only.');
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
