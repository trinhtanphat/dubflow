import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { createAsrProvider } from '../src/services/asr/router';
import { DeepgramNova3AsrProvider } from '../src/services/asr/deepgram';
import { WorkersAIAsrProvider } from '../src/services/asr/workers-ai';

const ai = {
  async run() { return { text: '', segments: [] }; },
} satisfies AiBinding;

describe('ASR provider routing', () => {
  it('prefers Deepgram Nova-3 when diarization credentials are configured', () => {
    expect(createAsrProvider(ai, ' dg-secret ')).toBeInstanceOf(DeepgramNova3AsrProvider);
  });

  it('falls back to Workers AI Whisper when Deepgram is not configured', () => {
    expect(createAsrProvider(ai, '')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(createAsrProvider(ai, undefined)).toBeInstanceOf(WorkersAIAsrProvider);
  });
});
