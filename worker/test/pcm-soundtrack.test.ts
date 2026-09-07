import { describe, expect, it } from 'vitest';
import { PcmSoundtrackService } from '../src/services/media/pcm-soundtrack';

function pcm16(samples: number[]): ArrayBuffer {
  return new Int16Array(samples).buffer;
}

function body(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

describe('PcmSoundtrackService', () => {
  it('meters raw PCM from durable byte size and streams one exact WAV soundtrack back to R2', async () => {
    const objects = new Map<string, ArrayBuffer>([
      ['voice-a.pcm', pcm16([100, 200])],
      ['voice-b.pcm', pcm16([300, 400])],
    ]);
    const events: string[] = [];
    let published: { key: string; bytes: ArrayBuffer; contentType?: string } | null = null;
    const bucket = {
      async head(key: string) {
        const bytes = objects.get(key);
        return bytes ? { key, size: bytes.byteLength } : null;
      },
      async get(key: string) {
        events.push(`get:${key}`);
        const bytes = objects.get(key);
        return bytes ? { key, size: bytes.byteLength, body: body(bytes) } : null;
      },
      async put(key: string, value: ReadableStream<Uint8Array>, options?: { httpMetadata?: { contentType?: string } }) {
        events.push(`put:${key}`);
        expect(events.filter((event) => event.startsWith('get:'))).toHaveLength(0);
        const bytes = await new Response(value).arrayBuffer();
        published = { key, bytes, contentType: options?.httpMetadata?.contentType };
        objects.set(key, bytes);
        return { key, size: bytes.byteLength };
      },
    };

    const service = new PcmSoundtrackService(bucket as any, { sampleRate: 8, channels: 1, chunkSamples: 2 });
    await expect(service.durationSeconds('voice-a.pcm')).resolves.toBe(0.25);
    await expect(service.storeSoundtrack({
      projectId: 'p1',
      targetLanguage: 'vi',
      exportId: 'export-1',
      durationMs: 1000,
      clips: [
        { startMs: 250, endMs: 500, objectKey: 'voice-a.pcm' },
        { startMs: 750, endMs: 1000, objectKey: 'voice-b.pcm' },
      ],
    })).resolves.toBe('projects/p1/soundtracks/vi/export-1.wav');

    expect(published).not.toBeNull();
    expect(published!.contentType).toBe('audio/wav');
    expect([...new Int16Array(published!.bytes.slice(44))]).toEqual([0, 0, 100, 200, 0, 0, 300, 400]);
    expect(events).toEqual([
      'put:projects/p1/soundtracks/vi/export-1.wav',
      'get:voice-a.pcm',
      'get:voice-b.pcm',
    ]);
  });

  it('fails closed when a durable PCM clip is missing', async () => {
    const bucket = {
      async head() { return null; },
      async get() { return null; },
      async put(_key: string, value: ReadableStream<Uint8Array>) { await new Response(value).arrayBuffer(); return {}; },
    };
    const service = new PcmSoundtrackService(bucket as any, { sampleRate: 8 });
    await expect(service.storeSoundtrack({
      projectId: 'p1', targetLanguage: 'vi', exportId: 'e1', durationMs: 1000,
      clips: [{ startMs: 0, endMs: 500, objectKey: 'missing.pcm' }],
    })).rejects.toThrow(/PCM_ARTIFACT_MISSING/);
  });
});
