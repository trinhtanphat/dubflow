import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AiBinding, AiRunOptions } from '../src/cloudflare/ai';
import type { Env } from '../src/env';
import type { UsageRecordInput } from '../src/db/usage';
import { createExportRoutes } from '../src/routes/export';
import { createVoiceProvider } from '../src/services/voice/provider';
import { WorkersAIVoiceProvider } from '../src/services/voice/workers-ai';
import { runExportPipeline } from '../src/workflows/exportPipeline';

class FakeAI implements AiBinding {
  calls: Array<{ model: string; input: unknown; options?: AiRunOptions }> = [];

  constructor(private readonly result: unknown = { state: 'Completed', result: { audio: 'https://audio.test/grok.pcm' } }) {}

  async run(model: string, input: unknown, options?: AiRunOptions): Promise<unknown> {
    this.calls.push({ model, input, options });
    return this.result;
  }
}

const allowExport = { async limit() { return { success: true }; } };
const analytics = { writeDataPoint() {} };

function directStep() {
  return { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
}

function zeroContainerDeps(usageEvents: UsageRecordInput[], speakers: Array<{ id: string; voiceProvider?: string | null; voiceId?: string | null }> = []) {
  return {
    projects: {
      getByIdForUser: vi.fn(async () => ({
        id: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4', durationMs: 10_000,
      })),
      setStatus: vi.fn(async () => {}),
      setExportObject: vi.fn(async () => {}),
    },
    jobs: {
      getForProject: vi.fn(async () => ({ status: 'running' as const, retryCount: 0 })),
      setProgress: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    },
    segments: {
      list: vi.fn(async () => [{
        id: 's1', speakerId: speakers.length ? 'speaker-1' : null, startMs: 0, endMs: 1500,
        translatedText: 'Xin chào', voiceStatus: 'pending', dubbedObjectKey: null, version: 1,
      }]),
      setVoiceResult: vi.fn(async () => {}),
    },
    speakers: { list: vi.fn(async () => speakers) },
    bucket: { put: vi.fn(async () => ({})) },
    voice: {
      capabilities: () => ({
        provider: 'workers-ai', configured: true, languages: ['vi'], cloning: false, preview: true,
        cloneEnrollment: { provider: 'elevenlabs' as const, mode: 'ivc' as const, available: false },
      }),
      generate: vi.fn(async () => new Response(new Uint8Array([1, 0, 2, 0]))),
    },
    soundtrack: {
      durationSeconds: vi.fn(async () => 1.5),
      storeSoundtrack: vi.fn(async () => 'projects/p1/soundtracks/vi/legacy.wav'),
    },
    publisher: {
      inspect: vi.fn(async () => ({ codec: 'avc', durationSeconds: 10 })),
      publishDubbedExport: vi.fn(async () => ({ exportObjectKey: 'projects/p1/export/dubbed.mp4' })),
    },
    usage: {
      record: vi.fn(async (input: UsageRecordInput) => { usageEvents.push(input); return input as never; }),
      getByOperation: vi.fn(async () => null),
    },
    telemetry: { write: vi.fn(async () => {}) },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('production Grok TTS fallback', () => {
  it('reports the selected Grok model as provider provenance while native Workers AI keeps its generic label', () => {
    const ai = new FakeAI();
    const selected = createVoiceProvider({ AI: ai, PAID_GROK_TTS_ENABLED: 'true' } as unknown as Env);
    const native = new WorkersAIVoiceProvider(ai, {
      model: '@cf/myshell-ai/melotts',
      verifiedLanguages: ['en'],
    });

    expect(selected.capabilities().provider).toBe('xai/grok-tts');
    expect(native.capabilities().provider).toBe('workers-ai');
  });

  it('requests Vietnamese raw PCM 24 kHz and fetches the Unified AI presigned audio URL', async () => {
    const ai = new FakeAI();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'audio/pcm' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new WorkersAIVoiceProvider(ai, {
      model: 'xai/grok-tts',
      verifiedLanguages: ['vi'],
      voice: 'eve',
    });
    const response = await provider.generate({ text: 'Xin chào', language: 'vi', outputFormat: 'pcm_24000' });

    expect(ai.calls).toEqual([{
      model: 'xai/grok-tts',
      input: {
        text: 'Xin chào',
        language: 'vi',
        voice_id: 'eve',
        output_format: { codec: 'pcm', sample_rate: 24000 },
      },
      options: undefined,
    }]);
    expect(fetchMock).toHaveBeenCalledWith('https://audio.test/grok.pcm');
    expect(response).toBeInstanceOf(Response);
    expect(Array.from(new Uint8Array(await (response as Response).arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('admits Vietnamese dubbed export through the AI binding without synthesizing during admission', async () => {
    const calls: string[] = [];
    const ai = new FakeAI();
    const routes = createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() {
          return { id: 'p1', userId: 'dev-user', status: 'needs_review', sourceObjectKey: 'projects/p1/source/a.mp4' };
        },
        async setStatus(_id: string, _userId: string, status: string) { calls.push(`project:${status}`); },
      }) as never,
      makeJobs: () => ({
        async create() { calls.push('job:create'); return { id: 'j1' }; },
        async fail() {},
      }) as never,
      makeLanguages: () => ({
        async getConfig() { return { revision: 1, languages: [{ targetLanguage: 'vi' as const }] }; },
      }) as never,
      makeSegments: () => ({ async list() { return [{ id: 's1' }]; } }) as never,
      makeVariants: () => ({
        async list() {
          return [{ segmentId: 's1', targetLanguage: 'vi', translationStatus: 'completed', translatedText: 'Xin chào' }];
        },
      }) as never,
      makeExports: () => ({
        async create() { calls.push('export:create'); return { id: 'e1' }; },
        async latest() { return null; },
        async latestCompleted() { return null; },
        async fail() {},
      }) as never,
    });

    const response = await routes.fetch(new Request('https://yupvox.test/p1/export', { method: 'POST' }), {
      MEDIA: {},
      AI: ai,
      PAID_GROK_TTS_ENABLED: 'true',
      ANALYTICS: analytics,
      RATE_LIMIT_EXPORT: allowExport,
      EXPORT_WORKFLOW: {
        async create() { calls.push('workflow:create'); return { id: 'wf1' }; },
      },
    } as unknown as Env);

    expect(response.status).toBe(202);
    expect(calls).toEqual(['export:create', 'job:create', 'project:processing', 'workflow:create']);
    expect(ai.calls).toHaveLength(0);
  });

  it('attributes zero-container TTS usage to the selected Workers AI provider', async () => {
    const usageEvents: UsageRecordInput[] = [];
    const deps = zeroContainerDeps(usageEvents);

    await runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1' },
      deps as never,
      directStep() as never,
    );

    expect(usageEvents.filter((event) => event.kind === 'tts_audio_second')).toEqual([
      expect.objectContaining({
        provider: 'workers-ai', phase: 'started', operationKey: 'job:j1:retry:0:tts:s1:workers-ai',
      }),
      expect.objectContaining({
        provider: 'workers-ai', phase: 'completed', operationKey: 'job:j1:retry:0:tts:s1:workers-ai',
      }),
    ]);
  });

  it('does not send an ElevenLabs speaker voice id through the Workers AI fallback', async () => {
    const usageEvents: UsageRecordInput[] = [];
    const deps = zeroContainerDeps(usageEvents, [{
      id: 'speaker-1', voiceProvider: 'elevenlabs', voiceId: 'voice-heroine',
    }]);

    await expect(runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1' },
      deps as never,
      directStep() as never,
    )).rejects.toThrow(/ElevenLabs voice/i);

    expect(deps.voice.generate).not.toHaveBeenCalled();
  });
});
