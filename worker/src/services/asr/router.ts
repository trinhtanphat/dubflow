import type { AiBinding } from '../../cloudflare/ai';
import type { AsrProvider } from './types';
import { DeepgramNova3AsrProvider } from './deepgram';
import { WorkersAIAsrProvider } from './workers-ai';

export type AsrCapabilities = {
  provider: 'deepgram-nova-3' | 'workers-ai-whisper-large-v3-turbo';
  speakerDiarization: 'configured' | 'unavailable';
  speakerIdentityScope: 'chunk' | 'none';
};

function qualifiedDeepgramApiKey(
  deepgramApiKey?: string,
  paidDeepgramAsrEnabled?: string,
): string | undefined {
  if (paidDeepgramAsrEnabled?.trim().toLowerCase() !== 'true') return undefined;
  const apiKey = deepgramApiKey?.trim();
  return apiKey || undefined;
}

export function asrCapabilities(
  deepgramApiKey?: string,
  paidDeepgramAsrEnabled?: string,
): AsrCapabilities {
  const apiKey = qualifiedDeepgramApiKey(deepgramApiKey, paidDeepgramAsrEnabled);
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

export function createAsrProvider(
  ai: AiBinding,
  deepgramApiKey?: string,
  paidDeepgramAsrEnabled?: string,
): AsrProvider {
  const apiKey = qualifiedDeepgramApiKey(deepgramApiKey, paidDeepgramAsrEnabled);
  return apiKey
    ? new DeepgramNova3AsrProvider(apiKey)
    : new WorkersAIAsrProvider(ai);
}
