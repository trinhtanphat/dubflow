import { describe, expect, it } from 'vitest';
import type { TelemetryEvent } from '../src/observability/telemetry';
import { runDubbingPipeline } from '../src/workflows/pipeline';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
}

function recordingTelemetry(events: TelemetryEvent[]) {
  return { write(event: TelemetryEvent) { events.push(event); } };
}

function dubbingDeps(events: TelemetryEvent[], failAsr = false) {
  const usageEvents: Array<{ phase: string; kind: string }> = [];
  return {
    usageEvents,
    deps: {
      projects: {
        async getByIdForUser() {
          return { id: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4', sourceLanguage: 'en' as const };
        },
        async setStatus() {},
      },
      jobs: {
        async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
        async setProgress() {},
        async fail() {},
        async complete() {},
      },
      media: {
        async probe() { return { durationMs: 1_000 }; },
        async extractAudioChunks() {
          return [{
            objectKey: 'projects/p1/audio/000.wav',
            offsetMs: 0,
            durationMs: 1_000,
            overlapBeforeMs: 0,
            overlapAfterMs: 0,
          }];
        },
      },
      bucket: {
        async get(key: string) {
          return {
            key,
            size: 1,
            body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }),
          };
        },
      },
      asr: {
        async transcribe() {
          if (failAsr) throw new Error('raw upstream ASR secret response');
          return { text: 'private source sentence', segments: [{ startMs: 0, endMs: 500, text: 'private source sentence', speakerIndex: 0 }] };
        },
      },
      asrProviderId: 'deepgram-nova-3',
      segments: {
        async list() { return []; },
        async replaceFromAsr() {
          return [{
            id: 's1', projectId: 'p1', speakerId: 'spk-1', startMs: 0, endMs: 500,
            sourceText: 'private source sentence', translatedText: '', translationEngine: 'workers-ai',
            translationStatus: 'pending', voiceStatus: 'pending', dubbedObjectKey: null, version: 1, splitParentId: null,
          }];
        },
        async setTranslationResult() { return null; },
      },
      translation: {
        async translateBatch(items: Array<{ id: string }>) {
          return items.map((item) => ({ id: item.id, text: 'private translated sentence', provider: 'workers-ai' }));
        },
      },
      translationProviderId: 'workers-ai',
      usage: {
        async record(input: { phase: string; kind: string }) {
          usageEvents.push({ phase: input.phase, kind: input.kind });
          return input as never;
        },
      },
      telemetry: recordingTelemetry(events),
    },
  };
}

function exportDeps(events: TelemetryEvent[], failVoice = false) {
  const usageEvents: Array<{ phase: string; kind: string }> = [];
  return {
    usageEvents,
    deps: {
      projects: {
        async getByIdForUser() {
          return { id: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4', durationMs: 10_000 };
        },
        async setStatus() {},
        async setExportObject() {},
      },
      jobs: {
        async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
        async setProgress() {},
        async fail() {},
        async complete() {},
      },
      segments: {
        async list() {
          return [{
            id: 's1', speakerId: null, startMs: 0, endMs: 1_000,
            translatedText: 'private voice sentence', voiceStatus: 'pending', dubbedObjectKey: null,
          }];
        },
        async setVoiceResult() {},
      },
      bucket: { async put() {} },
      voice: {
        async generate() {
          if (failVoice) throw new Error('raw ElevenLabs secret response');
          return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
        },
      },
      media: {
        async probe(key: string) { return { durationMs: key.includes('/dubbed/') ? 1_250 : 10_000 }; },
        async renderExport() { return { exportObjectKey: 'projects/p1/export/final.mp4' }; },
      },
      usage: {
        async getByOperation() { return null; },
        async record(input: { phase: string; kind: string }) {
          usageEvents.push({ phase: input.phase, kind: input.kind });
          return input as never;
        },
      },
      telemetry: recordingTelemetry(events),
    },
  };
}

describe('Phase 3C durable workflow provider telemetry', () => {
  it('emits correlated ASR and translation success without changing usage ordering', async () => {
    const events: TelemetryEvent[] = [];
    const { deps, usageEvents } = dubbingDeps(events);

    await runDubbingPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1', requestId: 'req-workflow' } as never,
      deps as never,
      step(),
    );

    expect(events).toEqual([
      expect.objectContaining({
        name: 'provider_success', requestId: 'req-workflow', actorId: 'dev-user', projectId: 'p1', jobId: 'j1',
        operation: 'asr', provider: 'deepgram-nova-3', status: 'success',
      }),
      expect.objectContaining({
        name: 'provider_success', requestId: 'req-workflow', actorId: 'dev-user', projectId: 'p1', jobId: 'j1',
        operation: 'translate', provider: 'workers-ai', status: 'success',
      }),
    ]);
    expect(usageEvents.map((event) => `${event.kind}:${event.phase}`)).toEqual([
      'asr_audio_second:started', 'asr_audio_second:completed',
      'translation_character:started', 'translation_character:completed',
    ]);
    expect(JSON.stringify(events)).not.toContain('private source sentence');
    expect(JSON.stringify(events)).not.toContain('private translated sentence');
  });

  it('emits normalized ASR failure without raw provider errors', async () => {
    const events: TelemetryEvent[] = [];
    const { deps } = dubbingDeps(events, true);

    await expect(runDubbingPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1', requestId: 'req-workflow' } as never,
      deps as never,
      step(),
    )).rejects.toThrow('raw upstream ASR secret response');

    expect(events).toEqual([
      expect.objectContaining({
        name: 'provider_failure', requestId: 'req-workflow', projectId: 'p1', jobId: 'j1',
        operation: 'asr', provider: 'deepgram-nova-3', errorCode: 'ASR_FAILED', status: 'failure',
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('raw upstream ASR secret response');
  });

  it('emits TTS and render success without changing usage ordering', async () => {
    const events: TelemetryEvent[] = [];
    const { deps, usageEvents } = exportDeps(events);

    await runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1', requestId: 'req-workflow' } as never,
      deps as never,
      step(),
    );

    expect(events).toEqual([
      expect.objectContaining({
        name: 'provider_success', requestId: 'req-workflow', actorId: 'dev-user', projectId: 'p1', jobId: 'j1',
        operation: 'voice', provider: 'elevenlabs', status: 'success',
      }),
      expect.objectContaining({
        name: 'provider_success', requestId: 'req-workflow', actorId: 'dev-user', projectId: 'p1', jobId: 'j1',
        operation: 'render', provider: 'ffmpeg-container', status: 'success',
      }),
    ]);
    expect(usageEvents.map((event) => `${event.kind}:${event.phase}`)).toEqual([
      'tts_audio_second:started', 'tts_audio_second:completed',
      'render_second:started', 'render_second:completed',
    ]);
    expect(JSON.stringify(events)).not.toContain('private voice sentence');
  });

  it('emits normalized ElevenLabs failure without raw provider errors', async () => {
    const events: TelemetryEvent[] = [];
    const { deps } = exportDeps(events, true);

    await expect(runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1', requestId: 'req-workflow' } as never,
      deps as never,
      step(),
    )).rejects.toThrow('raw ElevenLabs secret response');

    expect(events).toEqual([
      expect.objectContaining({
        name: 'provider_failure', requestId: 'req-workflow', projectId: 'p1', jobId: 'j1',
        operation: 'voice', provider: 'elevenlabs', errorCode: 'VOICE_PROVIDER_FAILED', status: 'failure',
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('raw ElevenLabs secret response');
  });
});
