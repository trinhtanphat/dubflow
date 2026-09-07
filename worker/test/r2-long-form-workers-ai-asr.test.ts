import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runDubbingPipeline } from '../src/workflows/pipeline';

const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };
const telemetry = { write() {} };

const longFormSource = readFileSync(
  new URL('../src/services/asr/r2-long-form.ts', import.meta.url),
  'utf8',
);

describe('R2 long-form Workers AI ASR', () => {
  it('uses encoded AAC packet demux/remux only and never relies on runtime audio decode/transcode', () => {
    expect(longFormSource).toMatch(/EncodedPacketSink/);
    expect(longFormSource).toMatch(/EncodedAudioPacketSource/);
    expect(longFormSource).toMatch(/Mp4OutputFormat/);
    expect(longFormSource).not.toMatch(/\bConversion\b|WavOutputFormat|forceTranscode|AudioDecoder|@mediabunny\/server/);
  });

  it('transcribes bounded injected chunks and preserves their timeline offsets without a paid remote provider', async () => {
    const transcribe = vi.fn(async (_audio: ArrayBuffer) => ({
      text: 'chunk',
      segments: [{ startMs: 1_000, endMs: 2_000, text: 'chunk' }],
    }));
    const extractSourceAudioChunks = vi.fn(async () => [
      { chunkId: 'source:0', audio: new Uint8Array([1]).buffer, offsetMs: 0, durationMs: 300_000, overlapBeforeMs: 0, overlapAfterMs: 0 },
      { chunkId: 'source:1', audio: new Uint8Array([2]).buffer, offsetMs: 300_000, durationMs: 300_000, overlapBeforeMs: 0, overlapAfterMs: 0 },
      { chunkId: 'source:2', audio: new Uint8Array([3]).buffer, offsetMs: 600_000, durationMs: 60_000, overlapBeforeMs: 0, overlapAfterMs: 0 },
    ]);
    const replaced: Array<{ startMs: number; endMs: number; sourceText: string }> = [];
    const projects = {
      async getByIdForUser() {
        return { id: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4', sourceLanguage: 'en' as const };
      },
      async setStatus() {},
    };
    const jobs = {
      async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
      async setProgress() {},
      async fail() {},
      async complete() {},
    };
    const segments = {
      async list() { return []; },
      async replaceFromAsr(_projectId: string, _userId: string, input: Array<{ id: string; speakerId: string | null; startMs: number; endMs: number; sourceText: string }>) {
        replaced.push(...input);
        return input.map((item) => ({
          projectId: 'p1',
          translatedText: '',
          translationEngine: 'workers-ai',
          translationContextRevision: null,
          translationStatus: 'pending' as const,
          voiceStatus: 'pending' as const,
          dubbedObjectKey: null,
          version: 1,
          splitParentId: null,
          ...item,
        }));
      },
      async setTranslationResult() { return null; },
    };
    const deps = {
      projects,
      jobs,
      sourceMedia: {
        async prepareSource() {
          return {
            sourceId: 'projects/p1/source/video.mp4',
            durationMs: 660_000,
            audioUrl: 'https://example.test/api/media-source/p1',
          };
        },
      },
      extractSourceAudioChunks,
      asr: { transcribe },
      asrProviderId: 'workers-ai-whisper-large-v3-turbo',
      segments,
      translationContext: {
        async getContext() { return { revision: 1, style: 'neutral' as const, glossary: [] }; },
      },
      translationRouter: {
        async translate(_mode: unknown, items: Array<{ id: string; text: string }>) {
          return {
            mode: 'workers-ai' as const,
            primary: items.map((item) => ({ id: item.id, text: `vi:${item.text}`, provider: 'workers-ai' as const })),
            contextRevision: null,
          };
        },
      },
      usage: { async record(input: unknown) { return input as never; } },
      telemetry,
    };

    await expect(runDubbingPipeline(
      { projectId: 'p1', userId: 'u1', jobId: 'j1' },
      deps,
      step,
    )).resolves.toEqual({ status: 'needs_review', segmentCount: 3 });

    expect(extractSourceAudioChunks).toHaveBeenCalledWith(
      'https://example.test/api/media-source/p1',
      660_000,
    );
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(replaced.map((segment) => segment.startMs)).toEqual([1_000, 301_000, 601_000]);
    expect(replaced.map((segment) => segment.endMs)).toEqual([2_000, 302_000, 602_000]);
  });
});
