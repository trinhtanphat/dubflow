export const CLIENT_PCM_SAMPLE_RATE = 24_000;
export const CLIENT_PCM_MAX_BYTES = 8 * 1024 * 1024;

type WavFormat = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

function ascii(view: DataView, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function parseWav(input: ArrayBuffer): { format: WavFormat; samples: Float32Array } {
  const view = new DataView(input);
  if (view.byteLength < 12 || ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') {
    throw new Error('Unsupported or malformed WAV container.');
  }

  let format: WavFormat | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  let offset = 12;

  while (offset + 8 <= view.byteLength) {
    const chunkId = ascii(view, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    const bodyEnd = bodyOffset + chunkLength;
    if (bodyEnd > view.byteLength) throw new Error('WAV chunk is truncated.');

    if (chunkId === 'fmt ') {
      if (chunkLength < 16) throw new Error('WAV fmt chunk is malformed.');
      format = {
        audioFormat: view.getUint16(bodyOffset, true),
        channels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      };
    } else if (chunkId === 'data' && dataOffset < 0) {
      dataOffset = bodyOffset;
      dataLength = chunkLength;
    }

    offset = bodyEnd + (chunkLength % 2);
  }

  if (!format) throw new Error('WAV fmt chunk is missing.');
  if (dataOffset < 0 || dataLength <= 0) throw new Error('WAV audio data is empty.');
  if (format.channels !== 1) throw new Error('Only mono WAV input is supported.');
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) throw new Error('WAV sample rate is invalid.');

  let samples: Float32Array;
  if (format.audioFormat === 1 && format.bitsPerSample === 16) {
    if (dataLength % 2 !== 0) throw new Error('PCM16 WAV data has an invalid byte length.');
    const count = dataLength / 2;
    samples = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768;
    }
  } else if (format.audioFormat === 3 && format.bitsPerSample === 32) {
    if (dataLength % 4 !== 0) throw new Error('Float WAV data has an invalid byte length.');
    const count = dataLength / 4;
    samples = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const value = view.getFloat32(dataOffset + index * 4, true);
      if (!Number.isFinite(value)) throw new Error('WAV contains non-finite samples.');
      samples[index] = value;
    }
  } else {
    throw new Error('Unsupported WAV encoding.');
  }

  if (samples.length === 0) throw new Error('WAV audio data is empty.');
  return { format, samples };
}

function resampleLinear(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === CLIENT_PCM_SAMPLE_RATE) return new Float32Array(input);
  const outputLength = Math.max(1, Math.round(input.length * CLIENT_PCM_SAMPLE_RATE / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / CLIENT_PCM_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const left = Math.min(Math.floor(sourcePosition), input.length - 1);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = sourcePosition - left;
    output[index] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

function encodeS16Le(samples: Float32Array): Uint8Array {
  const byteLength = samples.length * 2;
  if (byteLength <= 0 || byteLength % 2 !== 0) throw new Error('Client PCM output is invalid.');
  if (byteLength > CLIENT_PCM_MAX_BYTES) throw new Error('Client PCM exceeds the 8 MiB limit.');
  const output = new Uint8Array(byteLength);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!Number.isFinite(sample)) throw new Error('PCM sample is not finite.');
    const clamped = Math.max(-1, Math.min(1, sample));
    const encoded = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    view.setInt16(index * 2, encoded, true);
  }
  return output;
}

export function wavToClientPcm(input: ArrayBuffer): Uint8Array {
  const { format, samples } = parseWav(input);
  return encodeS16Le(resampleLinear(samples, format.sampleRate));
}
