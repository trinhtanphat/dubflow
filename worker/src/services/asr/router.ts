import type { AiBinding } from '../../cloudflare/ai';
import type { AsrProvider } from './types';
import { DeepgramNova3AsrProvider } from './deepgram';
import { WorkersAIAsrProvider } from './workers-ai';

export function createAsrProvider(ai: AiBinding, deepgramApiKey?: string): AsrProvider {
  const apiKey = deepgramApiKey?.trim();
  return apiKey
    ? new DeepgramNova3AsrProvider(apiKey)
    : new WorkersAIAsrProvider(ai);
}
