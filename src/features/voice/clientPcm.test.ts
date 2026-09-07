import { describe, expect, it } from 'vitest';
import { CLIENT_PCM_MAX_BYTES, CLIENT_PCM_SAMPLE_RATE, wavToClientPcm } from './clientPcm';

function chunk(id: string, payload: Uint8Array): Uint8Array {
  const padded = payload.byteLength + (payload.byteLength % 2);
  const out = new Uint8Array(8 + padded);
  const view = new DataView(out.buffer);
  for (let index = 0; index < 4; index += 1) out[index] = id.charCodeAt(index);
  view.setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}

function wav({
  sampleRate = 22_050,
  channels = 1,
  format = 1,
  bitsPerSample = 16,
  pcm16 = [0, 8192, -8192, 0],
  float32,
  extraChunks = [],
}: {
  sampleRate?: number;
  channels?: number;
  format?: number;
  bitsPerSample?: number;
  pcm16?: number[];
  float32?: number[];
  extraChunks?: Uint8Array[];
} = {}): ArrayBuffer {
  const bytesPerSample = bitsPerSample / 8;
  const fmt = new Uint8Array(16);
  const fmtView = new DataView(fmt.buffer);
  fmtView.setUint16(0, format, true);
  fmtView.setUint16(2, channels, true);
  fmtView.setUint32(4, sampleRate, true);
  fmtView.setUint32(8, sampleRate * channels * bytesPerSample, true);
  fmtView.setUint16(12, channels * bytesPerSample, true);
  fmtView.setUint16(14, bitsPerSample, true);

  const samples = float32 ?? pcm16;
  const data = new Uint8Array(samples.length * bytesPerSample);
  const dataView = new DataView(data.buffer);
  samples.forEach((sample, index) => {
    if (format === 3) dataView.setFloat32(index * 4, sample, true);
    else dataView.setInt16(index * 2, sample, true);
  });

  const chunks = [chunk('fmt ', fmt), ...extraChunks, chunk('data', data)];
  const bodyLength = chunks.reduce((sum, value) => sum + value.byteLength, 0);
  const out = new Uint8Array(12 + bodyLength);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, out.byteLength - 8, true);
  out.set(new TextEncoder().encode('WAVE'), 8);
  let offset = 12;
  for (const value of chunks) {
    out.set(value, offset);
    offset += value.byteLength;
  }
  return out.buffer;
}

function int16Samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 2) values.push(view.getInt16(offset, true));
  return values;
}

describe('wavToClientPcm', () => {
  it('resamples mono PCM16 WAV to exact 24 kHz s16le', () => {
    const pcm = wavToClientPcm(wav({ sampleRate: 22_050, pcm16: [0, 8192, -8192, 0] }));
    expect(CLIENT_PCM_SAMPLE_RATE).toBe(24_000);
    expect(pcm.byteLength).toBe(Math.round(4 * 24_000 / 22_050) * 2);
    expect(pcm.byteLength % 2).toBe(0);
    expect(int16Samples(pcm).some((value) => value !== 0)).toBe(true);
  });

  it('scans RIFF chunks instead of assuming a fixed header offset', () => {
    const metadata = chunk('JUNK', new Uint8Array([1, 2, 3]));
    expect(() => wavToClientPcm(wav({ extraChunks: [metadata] }))).not.toThrow();
  });

  it('accepts Piper-style mono float32 WAV and clamps samples', () => {
    const pcm = wavToClientPcm(wav({
      sampleRate: 24_000,
      format: 3,
      bitsPerSample: 32,
      float32: [-2, -1, 0, 1, 2],
    }));
    expect(int16Samples(pcm)).toEqual([-32768, -32768, 0, 32767, 32767]);
  });

  it('rejects stereo, compressed, malformed, and empty WAV input', () => {
    expect(() => wavToClientPcm(wav({ channels: 2 }))).toThrow(/mono/i);
    expect(() => wavToClientPcm(wav({ format: 6 }))).toThrow(/format|encoding/i);
    expect(() => wavToClientPcm(new ArrayBuffer(8))).toThrow(/WAV|RIFF/i);
    expect(() => wavToClientPcm(wav({ pcm16: [] }))).toThrow(/empty/i);
  });

  it('rejects output that would exceed the backend 8 MiB contract', () => {
    expect(CLIENT_PCM_MAX_BYTES).toBe(8 * 1024 * 1024);
    const hugeFrames = Math.floor(CLIENT_PCM_MAX_BYTES / 2) + 1;
    expect(() => wavToClientPcm(wav({ sampleRate: 24_000, pcm16: new Array(hugeFrames).fill(0) }))).toThrow(/8 MiB/i);
  });
});
