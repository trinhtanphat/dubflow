import { describe, expect, it } from 'vitest';
import { PcmTimelineAssembler } from '../src/services/media/pcm-timeline';

function pcm16(samples: number[]): ArrayBuffer {
  const out = new Int16Array(samples);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function dataSamples(wav: ArrayBuffer): Int16Array {
  return new Int16Array(wav.slice(44));
}

describe('PcmTimelineAssembler', () => {
  it('derives PCM duration and deterministically fits a clip to its target window', () => {
    const assembler = new PcmTimelineAssembler({ sampleRate: 8, channels: 1 });
    const source = pcm16([100, 200, 300, 400]);

    expect(assembler.durationMs(source.byteLength)).toBe(500);
    const fitted = assembler.fitClip(source, 1000);
    expect([...new Int16Array(fitted)]).toEqual([100, 100, 200, 200, 300, 300, 400, 400]);
  });

  it('streams a WAV timeline with silence gaps without allocating a project-length PCM buffer', async () => {
    const assembler = new PcmTimelineAssembler({ sampleRate: 8, channels: 1, chunkSamples: 2 });
    const stream = assembler.streamTimeline(1000, [
      { startMs: 250, endMs: 500, pcm: pcm16([100, 200]) },
      { startMs: 750, endMs: 1000, pcm: pcm16([300, 400]) },
    ]);
    const wav = await new Response(stream).arrayBuffer();

    expect(wav.byteLength).toBe(44 + 8 * 2);
    expect([...dataSamples(wav)]).toEqual([0, 0, 100, 200, 0, 0, 300, 400]);
  });

  it('rejects overlapping or malformed clip windows', () => {
    const assembler = new PcmTimelineAssembler({ sampleRate: 8, channels: 1 });
    expect(() => assembler.streamTimeline(1000, [
      { startMs: 250, endMs: 750, pcm: pcm16([1, 2]) },
      { startMs: 500, endMs: 900, pcm: pcm16([3, 4]) },
    ])).toThrow(/PCM_TIMELINE_INVALID/);
  });
});
