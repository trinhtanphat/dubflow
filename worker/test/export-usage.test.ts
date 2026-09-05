import { describe, expect, it } from 'vitest';
import { runExportPipeline } from '../src/workflows/exportPipeline';

type UsageRecord = {
  userId: string;
  projectId: string | null;
  jobId: string | null;
  kind: string;
  units: number;
  provider: string;
  idempotencyKey?: string;
};

function makeDeps(options: { durationMs?: number | null; invalidRenderKey?: boolean } = {}) {
  const records: UsageRecord[] = [];
  const voiceCalls: string[] = [];
  const renderCalls: string[] = [];
  const durationMs = Object.prototype.hasOwnProperty.call(options, 'durationMs') ? options.durationMs : 12_000;
  const segments = [
    {
      id: 'seg-new', speakerId: 'spk-1', startMs: 0, endMs: 5_000,
      translatedText: 'Xin chào', voiceStatus: 'pending', dubbedObjectKey: null,
    },
    {
      id: 'seg-cached', speakerId: 'spk-1', startMs: 5_000, endMs: 12_000,
      translatedText: 'Tạm biệt', voiceStatus: 'completed', dubbedObjectKey: 'projects/p1/dubbed/seg-cached.mp3',
    },
  ];

  const deps = {
    projects: {
      async getByIdForUser() { return { id: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4', durationMs }; },
      async setStatus() {},
      async setExportObject() {},
    },
    jobs: {
      async getForProject() { return { status: 'running' as const }; },
      async setProgress() {},
      async fail() {},
      async complete() {},
    },
    segments: {
      async list() { return segments; },
      async setVoiceResult() {},
    },
    speakers: {
      async list() { return [{ id: 'spk-1', voiceProvider: 'elevenlabs', voiceId: 'voice-1' }]; },
    },
    bucket: {
      async put() {},
    },
    voice: {
      async generate(input: { text: string }) {
        voiceCalls.push(input.text);
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    },
    media: {
      async renderExport() {
        renderCalls.push('render');
        return {
          exportObjectKey: options.invalidRenderKey
            ? 'wrong/export.mp4'
            : 'projects/p1/export/final.mp4',
        };
      },
    },
    usage: {
      async record(input: UsageRecord) {
        records.push(input);
        return { inserted: true, event: input };
      },
    },
  };

  return { deps, records, voiceCalls, renderCalls };
}

const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

describe('Phase 3B export usage metering', () => {
  it('records only newly generated TTS plus successful render with stable attempt keys', async () => {
    const { deps, records, voiceCalls, renderCalls } = makeDeps();

    await runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j-export', usageAttempt: 4 },
      deps as never,
      step,
    );

    expect(voiceCalls).toEqual(['Xin chào']);
    expect(renderCalls).toEqual(['render']);
    expect(records).toEqual([
      {
        userId: 'dev-user', projectId: 'p1', jobId: 'j-export',
        kind: 'tts_characters', units: 'Xin chào'.length, provider: 'elevenlabs',
        idempotencyKey: 'job:j-export:attempt:4:tts:seg-new',
      },
      {
        userId: 'dev-user', projectId: 'p1', jobId: 'j-export',
        kind: 'render_seconds', units: 12, provider: 'ffmpeg-container',
        idempotencyKey: 'job:j-export:attempt:4:render',
      },
    ]);
  });

  it('uses attempt zero when omitted and never meters a cached TTS clip', async () => {
    const { deps, records } = makeDeps();

    await runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j-export' },
      deps as never,
      step,
    );

    expect(records.map((record) => record.idempotencyKey)).toEqual([
      'job:j-export:attempt:0:tts:seg-new',
      'job:j-export:attempt:0:render',
    ]);
    expect(records.filter((record) => record.kind === 'tts_characters')).toHaveLength(1);
  });

  it('fails before render work and render metering when project duration is missing or invalid', async () => {
    for (const durationMs of [null, 0, Number.NaN]) {
      const { deps, records, renderCalls } = makeDeps({ durationMs });
      await expect(runExportPipeline(
        { projectId: 'p1', userId: 'dev-user', jobId: 'j-export' },
        deps as never,
        step,
      )).rejects.toThrow(/duration/i);
      expect(renderCalls).toEqual([]);
      expect(records.some((record) => record.kind === 'render_seconds')).toBe(false);
    }
  });

  it('does not record render usage when render output validation fails', async () => {
    const { deps, records } = makeDeps({ invalidRenderKey: true });
    await expect(runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j-export', usageAttempt: 2 },
      deps as never,
      step,
    )).rejects.toThrow(/invalid export object key/i);
    expect(records.some((record) => record.kind === 'render_seconds')).toBe(false);
  });
});
