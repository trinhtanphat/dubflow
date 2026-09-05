import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { asrCapabilities, createAsrProvider } from '../src/services/asr/router';
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

  it('reports configured chunk-scoped speaker diarization without claiming cross-chunk identity', () => {
    expect(asrCapabilities(' dg-secret ')).toEqual({
      provider: 'deepgram-nova-3',
      speakerDiarization: 'configured',
      speakerIdentityScope: 'chunk',
    });
  });

  it('reports diarization unavailable on the Workers AI fallback', () => {
    expect(asrCapabilities(undefined)).toEqual({
      provider: 'workers-ai-whisper-large-v3-turbo',
      speakerDiarization: 'unavailable',
      speakerIdentityScope: 'none',
    });
  });
});
