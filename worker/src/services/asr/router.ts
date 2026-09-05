import type { AiBinding } from '../../cloudflare/ai';
import type { AsrProvider } from './types';
import { DeepgramNova3AsrProvider } from './deepgram';
import { WorkersAIAsrProvider } from './workers-ai';

export type AsrCapabilities = {
  provider: 'deepgram-nova-3' | 'workers-ai-whisper-large-v3-turbo';
  speakerDiarization: 'configured' | 'unavailable';
  speakerIdentityScope: 'chunk' | 'none';
};

export function asrCapabilities(deepgramApiKey?: string): AsrCapabilities {
  const apiKey = deepgramApiKey?.trim();
  return apiKey
    ? {
      provider: 'deepgram-nova-3',
      speakerDiarization: 'configured',
      speakerIdentityScope: 'chunk',
    }
    : {
      provider: 'workers-ai-whisper-large-v3-turbo',
      speakerDiarization: 'unavailable',
      speakerIdentityScope: 'none',
    };
}

export function createAsrProvider(ai: AiBinding, deepgramApiKey?: string): AsrProvider {
  const apiKey = deepgramApiKey?.trim();
  return apiKey
    ? new DeepgramNova3AsrProvider(apiKey)
    : new WorkersAIAsrProvider(ai);
}
