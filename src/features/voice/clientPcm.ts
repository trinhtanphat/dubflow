export const CLIENT_PCM_SAMPLE_RATE = 24_000;
export const CLIENT_PCM_MAX_BYTES = 8 * 1024 * 1024;

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const PCM_FORMAT = 1;
const IEEE_FLOAT_FORMAT = 3;

type WavFormat = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function requireRange(length: number, offset: number, size: number, message: string) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > length) {
    throw new Error(message);
  }
}

function parseWav(input: ArrayBuffer): { format: WavFormat; data: DataView } {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength < RIFF_HEADER_BYTES || fourCc(bytes, 0) !== 'RIFF' || fourCc(bytes, 8) !== 'WAVE') {
    throw new Error('Invalid RIFF/WAV input.');
  }

  const view = new DataView(input);
  let format: WavFormat | null = null;
  let data: DataView | null = null;
  let offset = RIFF_HEADER_BYTES;

  while (offset + CHUNK_HEADER_BYTES <= bytes.byteLength) {
    const id = fourCc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const payloadOffset = offset + CHUNK_HEADER_BYTES;
    requireRange(bytes.byteLength, payloadOffset, size, `Truncated WAV ${id} chunk.`);

    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format chunk.');
      format = {
        audioFormat: view.getUint16(payloadOffset, true),
        channels: view.getUint16(payloadOffset + 2, true),
        sampleRate: view.getUint32(payloadOffset + 4, true),
        bitsPerSample: view.getUint16(payloadOffset + 14, true),
      };
    } else if (id === 'data') {
      data = new DataView(input, payloadOffset, size);
    }

    offset = payloadOffset + size + (size % 2);
  }

  if (!format) throw new Error('WAV format chunk is missing.');
  if (!data) throw new Error('WAV data chunk is missing.');
  if (format.channels !== 1) throw new Error('Client voice WAV must be mono.');
  if (!Number.isSafeInteger(format.sampleRate) || format.sampleRate <= 0) throw new Error('WAV sample rate is invalid.');

  const supportedPcm = format.audioFormat === PCM_FORMAT && format.bitsPerSample === 16;
  const supportedFloat = format.audioFormat === IEEE_FLOAT_FORMAT && format.bitsPerSample === 32;
  if (!supportedPcm && !supportedFloat) throw new Error('Unsupported WAV encoding or sample format.');

  const bytesPerSample = format.bitsPerSample / 8;
  if (data.byteLength === 0) throw new Error('WAV audio data is empty.');
  if (data.byteLength % bytesPerSample !== 0) throw new Error('WAV audio data is truncated.');

  return { format, data };
}

function decodeSamples(format: WavFormat, data: DataView): Float32Array {
  const bytesPerSample = format.bitsPerSample / 8;
  const count = data.byteLength / bytesPerSample;
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * bytesPerSample;
    samples[index] = format.audioFormat === IEEE_FLOAT_FORMAT
      ? data.getFloat32(offset, true)
      : data.getInt16(offset, true) / 32768;
  }
  return samples;
}

function resampleLinear(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === CLIENT_PCM_SAMPLE_RATE) return samples;
  const targetFrames = Math.max(1, Math.round(samples.length * CLIENT_PCM_SAMPLE_RATE / sourceRate));
  if (targetFrames * 2 > CLIENT_PCM_MAX_BYTES) throw new Error('Client PCM exceeds the 8 MiB limit.');

  const output = new Float32Array(targetFrames);
  for (let index = 0; index < targetFrames; index += 1) {
    const sourcePosition = index * sourceRate / CLIENT_PCM_SAMPLE_RATE;
    const left = Math.min(samples.length - 1, Math.floor(sourcePosition));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourcePosition - left;
    output[index] = samples[left] + (samples[right] - samples[left]) * fraction;
  }
  return output;
}

function encodeS16le(samples: Float32Array): Uint8Array {
  if (samples.length === 0) throw new Error('Client PCM output is empty.');
  const byteLength = samples.length * 2;
  if (byteLength > CLIENT_PCM_MAX_BYTES) throw new Error('Client PCM exceeds the 8 MiB limit.');

  const output = new Uint8Array(byteLength);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
    const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    view.setInt16(index * 2, value, true);
  }
  return output;
}

export function wavToClientPcm(input: ArrayBuffer): Uint8Array {
  const { format, data } = parseWav(input);
  const source = decodeSamples(format, data);
  const targetFrames = format.sampleRate === CLIENT_PCM_SAMPLE_RATE
    ? source.length
    : Math.max(1, Math.round(source.length * CLIENT_PCM_SAMPLE_RATE / format.sampleRate));
  if (targetFrames * 2 > CLIENT_PCM_MAX_BYTES) throw new Error('Client PCM exceeds the 8 MiB limit.');
  return encodeS16le(resampleLinear(source, format.sampleRate));
}
