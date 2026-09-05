import { describe, expect, it, vi } from 'vitest';
import { runExportPipeline } from '../src/workflows/exportPipeline';

function step() {
  return { do: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) };
}

describe('speaker-specific voice export', () => {
  it('passes the assigned ElevenLabs voice id for each diarized speaker', async () => {
    const voiceGenerate = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'audio/mpeg' },
    }));
    const deps = {
      projects: {
        getByIdForUser: vi.fn(async () => ({ id: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4' })),
        setStatus: vi.fn(async () => {}),
        setExportObject: vi.fn(async () => {}),
      },
      jobs: {
        getForProject: vi.fn(async () => ({ status: 'running' as const })),
        setProgress: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
        complete: vi.fn(async () => {}),
      },
      segments: {
        list: vi.fn(async () => [{
          id: 's1', speakerId: 'speaker-1', startMs: 0, endMs: 1000,
          translatedText: 'Xin chào', voiceStatus: 'pending', dubbedObjectKey: null,
        }]),
        setVoiceResult: vi.fn(async () => {}),
      },
      speakers: {
        list: vi.fn(async () => [{
          id: 'speaker-1', projectId: 'p1', label: 'SPEAKER_00', displayName: 'Nữ chính',
          voiceProvider: 'elevenlabs', voiceId: 'voice-heroine', avatarObjectKey: null,
        }]),
      },
      bucket: { put: vi.fn(async () => ({})) },
      voice: { generate: voiceGenerate },
      media: { renderExport: vi.fn(async () => ({ exportObjectKey: 'projects/p1/export/dubbed.mp4' })) },
    };

    await runExportPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, deps as any, step() as any);

    expect(deps.speakers.list).toHaveBeenCalledWith('p1', 'dev-user');
    expect(voiceGenerate).toHaveBeenCalledWith({
      text: 'Xin chào',
      language: 'vi',
      voice: 'voice-heroine',
    });
  });
});
