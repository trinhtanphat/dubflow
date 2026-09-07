export const CLIENT_PCM_SAMPLE_RATE = 24_000;
export const CLIENT_PCM_MAX_BYTES = 8 * 1024 * 1024;

function assertFiniteRate(rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Audio sample rate is invalid.');
}

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) throw new Error('Decoded audio has no channels.');
  const length = channels[0].length;
  if (length === 0) throw new Error('Decoded audio is empty.');
  if (channels.some((channel) => channel.length !== length)) throw new Error('Decoded audio channels have mismatched lengths.');

  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of channels) {
      const value = channel[i];
      if (!Number.isFinite(value)) throw new Error('Decoded audio contains non-finite samples.');
      sum += value;
    }
    output[i] = sum / channels.length;
  }
  return output;
}

export function resampleLinear(
  input: Float32Array,
  sourceRate: number,
  targetRate = CLIENT_PCM_SAMPLE_RATE,
): Float32Array {
  assertFiniteRate(sourceRate);
  assertFiniteRate(targetRate);
  if (input.length === 0) throw new Error('Decoded audio is empty.');
  if (sourceRate === targetRate) return new Float32Array(input);

  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.min(Math.floor(position), input.length - 1);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[i] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

export function encodeS16Le(samples: Float32Array): Uint8Array {
  if (samples.length === 0) throw new Error('Decoded audio is empty.');
  const bytes = samples.length * 2;
  if (bytes > CLIENT_PCM_MAX_BYTES) throw new Error('Client PCM exceeds the 8 MiB limit.');
  const output = new Uint8Array(bytes);
  const view = new DataView(output.buffer);
  samples.forEach((sample, index) => {
    if (!Number.isFinite(sample)) throw new Error('Decoded audio contains non-finite samples.');
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    view.setInt16(index * 2, value, true);
  });
  return output;
}

export function canonicalPcmFromDecodedAudio(input: {
  sampleRate: number;
  channels: Float32Array[];
}): Uint8Array {
  const mono = mixToMono(input.channels);
  const resampled = resampleLinear(mono, input.sampleRate, CLIENT_PCM_SAMPLE_RATE);
  return encodeS16Le(resampled);
}

export async function decodeWavBlob(
  wav: Blob,
  decode: (data: ArrayBuffer) => Promise<{
    sampleRate: number;
    numberOfChannels: number;
    getChannelData(index: number): Float32Array;
  }>,
): Promise<Uint8Array> {
  if (wav.size === 0) throw new Error('Piper returned an empty WAV.');
  const decoded = await decode(await wav.arrayBuffer());
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => new Float32Array(decoded.getChannelData(index)));
  return canonicalPcmFromDecodedAudio({ sampleRate: decoded.sampleRate, channels });
}
