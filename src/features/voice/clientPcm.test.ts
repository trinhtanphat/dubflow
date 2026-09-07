import { describe, expect, it } from 'vitest';
import { CLIENT_PCM_SAMPLE_RATE, wavToClientPcm } from './clientPcm';

type WavOptions = {
  sampleRate: number;
  channels: number;
  frames: number[][];
  audioFormat?: number;
  bitsPerSample?: number;
};

function ascii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function wav({ sampleRate, channels, frames, audioFormat = 1, bitsPerSample = 16 }: WavOptions): ArrayBuffer {
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = frames.length * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  ascii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(view, 8, 'WAVE');
  ascii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const frame of frames) {
    for (let channel = 0; channel < channels; channel += 1) {
      if (bitsPerSample === 16) view.setInt16(offset, frame[channel] ?? 0, true);
      else view.setUint8(offset, frame[channel] ?? 0);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

function samples(pcm: Uint8Array) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Array.from({ length: pcm.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
}

describe('client PCM conversion', () => {
  it('resamples 22.05 kHz mono PCM16 deterministically to 24 kHz mono s16le', () => {
    const sourceFrames = Array.from({ length: 441 }, () => [1234]);
    const pcm = wavToClientPcm(wav({ sampleRate: 22_050, channels: 1, frames: sourceFrames }));
    expect(CLIENT_PCM_SAMPLE_RATE).toBe(24_000);
    expect(pcm.byteLength).toBe(Math.round(441 * 24_000 / 22_050) * 2);
    expect(samples(pcm).every((sample) => sample === 1234)).toBe(true);
  });

  it('downmixes stereo before resampling and writes little-endian signed samples', () => {
    const pcm = wavToClientPcm(wav({
      sampleRate: 24_000,
      channels: 2,
      frames: [[1000, -1000], [2000, 0]],
    }));
    expect(samples(pcm)).toEqual([0, 1000]);
    expect([...pcm]).toEqual([0, 0, 232, 3]);
  });

  it('uses linear interpolation between source frames', () => {
    const pcm = wavToClientPcm(wav({
      sampleRate: 12_000,
      channels: 1,
      frames: [[0], [2000]],
    }));
    expect(samples(pcm)).toEqual([0, 1000, 2000, 2000]);
  });

  it('fails closed for malformed RIFF/WAVE data', () => {
    expect(() => wavToClientPcm(new Uint8Array([1, 2, 3]).buffer)).toThrow(/RIFF|WAVE/i);
    const malformed = wav({ sampleRate: 22_050, channels: 1, frames: [[1]] });
    new DataView(malformed).setUint8(0, 0);
    expect(() => wavToClientPcm(malformed)).toThrow(/RIFF/i);
  });

  it('rejects non-PCM and non-16-bit WAV input', () => {
    expect(() => wavToClientPcm(wav({
      sampleRate: 22_050,
      channels: 1,
      frames: [[1]],
      audioFormat: 3,
    }))).toThrow(/PCM/i);
    expect(() => wavToClientPcm(wav({
      sampleRate: 22_050,
      channels: 1,
      frames: [[1]],
      bitsPerSample: 8,
    }))).toThrow(/16/i);
  });
});
