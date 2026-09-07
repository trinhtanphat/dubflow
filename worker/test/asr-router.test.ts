import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { asrCapabilities, createAsrProvider } from '../src/services/asr/router';
import { DeepgramNova3AsrProvider } from '../src/services/asr/deepgram';
import { WorkersAIAsrProvider } from '../src/services/asr/workers-ai';

const ai = {
  async run() { return { text: '', segments: [] }; },
} satisfies AiBinding;

describe('ASR provider routing', () => {
  it('keeps Workers AI when only a Deepgram secret is configured', () => {
    expect(createAsrProvider(ai, ' dg-secret ')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(asrCapabilities(' dg-secret ')).toEqual({
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

  it('falls back to Workers AI Whisper when Deepgram is not configured', () => {
    expect(createAsrProvider(ai, '', 'true')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(createAsrProvider(ai, undefined, 'true')).toBeInstanceOf(WorkersAIAsrProvider);
  });

  it('does not treat non-true paid opt-in values as consent', () => {
    expect(createAsrProvider(ai, 'dg-secret', 'false')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(createAsrProvider(ai, 'dg-secret', '1')).toBeInstanceOf(WorkersAIAsrProvider);
    expect(createAsrProvider(ai, 'dg-secret', undefined)).toBeInstanceOf(WorkersAIAsrProvider);
  });

  it('reports diarization unavailable on the Workers AI fallback', () => {
    expect(asrCapabilities(undefined, 'true')).toEqual({
      provider: 'workers-ai-whisper-large-v3-turbo',
      speakerDiarization: 'unavailable',
      speakerIdentityScope: 'none',
    });
  });
});
