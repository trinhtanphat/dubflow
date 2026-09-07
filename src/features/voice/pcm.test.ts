import { describe, expect, it } from 'vitest';
import {
  CLIENT_PCM_MAX_BYTES,
  canonicalPcmFromDecodedAudio,
  encodeS16Le,
  mixToMono,
  resampleLinear,
} from './pcm';

describe('canonical Piper PCM conversion', () => {
  it('mixes channels to mono deterministically', () => {
    const mono = mixToMono([
      new Float32Array([1, -1]),
      new Float32Array([0, 1]),
    ]);
    expect([...mono]).toEqual([0.5, 0]);
  });

  it('resamples 22050 Hz to 24000 Hz with the expected output length', () => {
    const input = new Float32Array(22050).fill(0.25);
    const output = resampleLinear(input, 22050, 24000);
    expect(output).toHaveLength(24000);
    expect(output[1234]).toBeCloseTo(0.25, 5);
  });

  it('encodes clipped little-endian signed 16-bit samples', () => {
    const bytes = encodeS16Le(new Float32Array([-2, -1, 0, 1, 2]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(-32768);
    expect(view.getInt16(2, true)).toBe(-32768);
    expect(view.getInt16(4, true)).toBe(0);
    expect(view.getInt16(6, true)).toBe(32767);
    expect(view.getInt16(8, true)).toBe(32767);
  });

  it('rejects empty and non-finite decoded samples', () => {
    expect(() => mixToMono([])).toThrow('no channels');
    expect(() => mixToMono([new Float32Array()])).toThrow('empty');
    expect(() => encodeS16Le(new Float32Array([Number.NaN]))).toThrow('non-finite');
  });

  it('rejects PCM larger than 8 MiB', () => {
    const samples = new Float32Array((CLIENT_PCM_MAX_BYTES / 2) + 1);
    expect(() => encodeS16Le(samples)).toThrow('8 MiB');
  });

  it('combines mono mix, resampling and s16le encoding', () => {
    const pcm = canonicalPcmFromDecodedAudio({
      sampleRate: 22050,
      channels: [new Float32Array(22050).fill(0.5)],
    });
    expect(pcm.byteLength).toBe(24000 * 2);
    expect(pcm.byteLength % 2).toBe(0);
  });
});
