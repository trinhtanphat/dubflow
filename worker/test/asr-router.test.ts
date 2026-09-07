import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { asrCapabilities, createAsrProvider } from '../src/services/asr/router';
import { DeepgramNova3AsrProvider } from '../src/services/asr/deepgram';
import { WorkersAIAsrProvider } from '../src/services/asr/workers-ai';

const ai = {
  async run() { return { text: '', segments: [] }; },
} satisfies AiBinding;

describe('ASR provider routing', () => {
  it('keeps Workers AI when only a Deepgram secret is configured and Workers AI is explicitly enabled', () => {
    expect(createAsrProvider(ai, ' dg-secret ', undefined, 'true')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(asrCapabilities(' dg-secret ', undefined, 'true')).toEqual({
      provider: 'workers-ai-whisper-large-v3-turbo',
      speakerDiarization: 'unavailable',
      speakerIdentityScope: 'none',
    });
  });

  it('uses Deepgram Nova-3 only when paid Deepgram ASR is explicitly enabled', () => {
    expect(createAsrProvider(ai, ' dg-secret ', 'true')).toBeInstanceOf(DeepgramNova3AsrProvider);
    expect(asrCapabilities(' dg-secret ', 'true')).toEqual({
      provider: 'deepgram-nova-3',
      speakerDiarization: 'configured',
      speakerIdentityScope: 'chunk',
    });
  });

  it('falls back to Workers AI Whisper when Deepgram is not configured and Workers AI is explicitly enabled', () => {
    expect(createAsrProvider(ai, '', 'true', 'true')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(createAsrProvider(ai, undefined, 'true', 'true')).toBeInstanceOf(WorkersAIAsrProvider);
  });

  it('does not treat non-true Deepgram paid opt-in values as consent', () => {
    expect(createAsrProvider(ai, 'dg-secret', 'false', 'true')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(createAsrProvider(ai, 'dg-secret', '1', 'true')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(createAsrProvider(ai, 'dg-secret', undefined, 'true')).toBeInstanceOf(WorkersAIAsrProvider);
  });

  it('reports diarization unavailable on the explicitly enabled Workers AI fallback', () => {
    expect(asrCapabilities(undefined, 'true', 'true')).toEqual({
      provider: 'workers-ai-whisper-large-v3-turbo',
      speakerDiarization: 'unavailable',
      speakerIdentityScope: 'none',
    });
  });
});
