export const CLIENT_PCM_SAMPLE_RATE = 24_000;

const PCM_FORMAT = 1;
const PCM_BITS_PER_SAMPLE = 16;

type WavFormat = {
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
  audioFormat: number;
};

function ascii(view: DataView, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function parseWav(wav: ArrayBuffer): { view: DataView; format: WavFormat; dataOffset: number; dataSize: number } {
  if (wav.byteLength < 12) throw new Error('Invalid RIFF/WAVE audio.');
  const view = new DataView(wav);
  if (ascii(view, 0, 4) !== 'RIFF') throw new Error('Invalid RIFF audio header.');
  if (ascii(view, 8, 4) !== 'WAVE') throw new Error('Invalid WAVE audio header.');

  let format: WavFormat | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;

  while (offset + 8 <= view.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + size;
    if (payloadEnd > view.byteLength) throw new Error(`Invalid WAVE ${id} chunk length.`);

    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAVE fmt chunk.');
      format = {
        audioFormat: view.getUint16(payloadOffset, true),
        channels: view.getUint16(payloadOffset + 2, true),
        sampleRate: view.getUint32(payloadOffset + 4, true),
        blockAlign: view.getUint16(payloadOffset + 12, true),
        bitsPerSample: view.getUint16(payloadOffset + 14, true),
      };
    } else if (id === 'data' && dataOffset < 0) {
      dataOffset = payloadOffset;
      dataSize = size;
    }

    offset = payloadEnd + (size % 2);
  }

  if (!format) throw new Error('WAVE fmt chunk is missing.');
  if (dataOffset < 0) throw new Error('WAVE data chunk is missing.');
  if (format.audioFormat !== PCM_FORMAT) throw new Error('Only PCM WAV audio is supported.');
  if (format.bitsPerSample !== PCM_BITS_PER_SAMPLE) throw new Error('Only 16-bit PCM WAV audio is supported.');
  if (!Number.isInteger(format.channels) || format.channels <= 0) throw new Error('Invalid WAVE channel count.');
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) throw new Error('Invalid WAVE sample rate.');

  const expectedBlockAlign = format.channels * (format.bitsPerSample / 8);
  if (format.blockAlign !== expectedBlockAlign || format.blockAlign <= 0) {
    throw new Error('Invalid WAVE PCM block alignment.');
  }
  if (dataSize === 0 || dataSize % format.blockAlign !== 0) {
    throw new Error('WAVE PCM data must contain complete non-empty frames.');
  }

  return { view, format, dataOffset, dataSize };
}

function decodeMono(
  view: DataView,
  format: WavFormat,
  dataOffset: number,
  dataSize: number,
): Float64Array {
  const frameCount = dataSize / format.blockAlign;
  const mono = new Float64Array(frameCount);
  const bytesPerSample = format.bitsPerSample / 8;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = dataOffset + frame * format.blockAlign;
    let total = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      total += view.getInt16(frameOffset + channel * bytesPerSample, true);
    }
    mono[frame] = total / format.channels;
  }
  return mono;
}

function clampInt16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

function resampleToClientRate(source: Float64Array, sourceRate: number): Int16Array {
  const outputFrames = Math.max(1, Math.round(source.length * CLIENT_PCM_SAMPLE_RATE / sourceRate));
  const output = new Int16Array(outputFrames);

  for (let index = 0; index < outputFrames; index += 1) {
    const sourcePosition = index * sourceRate / CLIENT_PCM_SAMPLE_RATE;
    const leftIndex = Math.min(source.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const fraction = Math.max(0, Math.min(1, sourcePosition - leftIndex));
    const value = source[leftIndex] + (source[rightIndex] - source[leftIndex]) * fraction;
    output[index] = clampInt16(value);
  }
  return output;
}

export function wavToClientPcm(wav: ArrayBuffer): Uint8Array {
  const { view, format, dataOffset, dataSize } = parseWav(wav);
  const mono = decodeMono(view, format, dataOffset, dataSize);
  const samples = resampleToClientRate(mono, format.sampleRate);
  const pcm = new Uint8Array(samples.length * 2);
  const pcmView = new DataView(pcm.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    pcmView.setInt16(index * 2, samples[index], true); // little-endian signed 16-bit
  }
  return pcm;
}
