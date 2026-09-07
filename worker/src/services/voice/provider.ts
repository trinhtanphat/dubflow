import type { Env } from '../../env';
import { ElevenLabsVoiceProvider } from './elevenlabs';
import type { VoiceProvider } from './types';
import { WorkersAIVoiceProvider } from './workers-ai';

export const GROK_TTS_MODEL = 'xai/grok-tts';
export const GROK_TTS_DEFAULT_VOICE = 'eve';

export type VoiceProviderEnv = {
  AI?: Env['AI'];
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_DEFAULT_VOICE_ID?: string;
};

export function createVoiceProvider(env: VoiceProviderEnv): VoiceProvider {
  const elevenLabs = new ElevenLabsVoiceProvider(
    env.ELEVENLABS_API_KEY ?? '',
    { defaultVoiceId: env.ELEVENLABS_DEFAULT_VOICE_ID },
  );
  if (elevenLabs.capabilities().configured || !env.AI) return elevenLabs;

  return new WorkersAIVoiceProvider(env.AI, {
    model: GROK_TTS_MODEL,
    verifiedLanguages: ['vi'],
    voice: GROK_TTS_DEFAULT_VOICE,
  });
}
