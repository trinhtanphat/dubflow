import {
  ALL_FORMATS,
  BufferTarget,
  Conversion,
  Input,
  Output,
  UrlSource,
  WavOutputFormat,
} from 'mediabunny';

export const DIRECT_ASR_CHUNK_DURATION_MS = 300_000;
const DIRECT_ASR_SAMPLE_RATE = 16_000;

export type SourceAudioChunk = {
  chunkId: string;
  audio: ArrayBuffer;
  offsetMs: number;
  durationMs: number;
  overlapBeforeMs: number;
  overlapAfterMs: number;
};

function assertSource(audioUrl: string, durationMs: number): void {
  if (!audioUrl.trim()) throw new Error('ASR_CHUNK_SOURCE_UNAVAILABLE: Source audio URL is missing.');
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error('ASR_CHUNK_DURATION_INVALID: Source duration must be a positive integer number of milliseconds.');
  }
}

async function decodeChunk(
  audioUrl: string,
  offsetMs: number,
  endMs: number,
): Promise<ArrayBuffer> {
  const input = new Input({
    source: new UrlSource(audioUrl, {
      maxCacheSize: 8 * 1024 * 1024,
      parallelism: 1,
    }),
    formats: ALL_FORMATS,
  });
  const target = new BufferTarget();
  const output = new Output({
    format: new WavOutputFormat(),
    target,
  });

  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { discard: true },
      audio: {
        codec: 'pcm-s16',
        numberOfChannels: 1,
        sampleRate: DIRECT_ASR_SAMPLE_RATE,
        sampleFormat: 's16',
        forceTranscode: true,
      },
      trim: {
        start: offsetMs / 1000,
        end: endMs / 1000,
      },
      tags: {},
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new Error('ASR_CHUNK_DECODE_UNAVAILABLE: Source audio cannot be converted to bounded PCM WAV.');
    }
    await conversion.execute();
    if (!target.buffer?.byteLength) {
      throw new Error('ASR_CHUNK_DECODE_EMPTY: Source audio chunk conversion produced no data.');
    }
    return target.buffer;
  } finally {
    input.dispose();
  }
}

export async function extractR2LongFormAudioChunks(
  audioUrl: string,
  durationMs: number,
): Promise<SourceAudioChunk[]> {
  assertSource(audioUrl, durationMs);
  const chunks: SourceAudioChunk[] = [];

  for (let offsetMs = 0, index = 0; offsetMs < durationMs; offsetMs += DIRECT_ASR_CHUNK_DURATION_MS, index += 1) {
    const endMs = Math.min(durationMs, offsetMs + DIRECT_ASR_CHUNK_DURATION_MS);
    chunks.push({
      chunkId: `source:${index}`,
      audio: await decodeChunk(audioUrl, offsetMs, endMs),
      offsetMs,
      durationMs: endMs - offsetMs,
      overlapBeforeMs: 0,
      overlapAfterMs: 0,
    });
  }

  if (chunks.length === 0) {
    throw new Error('ASR_CHUNK_DECODE_EMPTY: Source audio produced no bounded chunks.');
  }
  return chunks;
}
