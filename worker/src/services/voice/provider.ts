import type { Env } from '../../env';
import { paidElevenLabsEnabled } from '../paid-provider-policy';
import { ElevenLabsVoiceProvider } from './elevenlabs';
import type { VoiceProvider } from './types';
import { WorkersAIVoiceProvider } from './workers-ai';

export const GROK_TTS_MODEL = 'xai/grok-tts';
export const GROK_TTS_DEFAULT_VOICE = 'eve';

export type VoiceProviderEnv = {
  AI?: Env['AI'];
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_DEFAULT_VOICE_ID?: string;
  PAID_ELEVENLABS_ENABLED?: string;
  PAID_GROK_TTS_ENABLED?: string;
};

export function createVoiceProvider(env: VoiceProviderEnv): VoiceProvider {
  const elevenLabsEnabled = paidElevenLabsEnabled(env);
  const elevenLabs = new ElevenLabsVoiceProvider(
    elevenLabsEnabled ? env.ELEVENLABS_API_KEY ?? '' : '',
    { defaultVoiceId: elevenLabsEnabled ? env.ELEVENLABS_DEFAULT_VOICE_ID : undefined },
  );
  if (elevenLabs.capabilities().configured || !env.AI) return elevenLabs;

  if (env.PAID_GROK_TTS_ENABLED !== 'true') {
    return new WorkersAIVoiceProvider(env.AI);
  }

  return new WorkersAIVoiceProvider(env.AI, {
    model: GROK_TTS_MODEL,
    verifiedLanguages: ['vi'],
    voice: GROK_TTS_DEFAULT_VOICE,
    provider: GROK_TTS_MODEL,
  });
}
