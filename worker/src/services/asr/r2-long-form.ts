import {
  ALL_FORMATS,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
  type EncodedPacket,
} from 'mediabunny';

export const DIRECT_ASR_CHUNK_DURATION_MS = 300_000;
const DIRECT_ASR_CHUNK_DURATION_SECONDS = DIRECT_ASR_CHUNK_DURATION_MS / 1000;

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

function packetEndSeconds(packet: EncodedPacket): number {
  return packet.timestamp + packet.duration;
}

function assertPacketTimeline(packet: EncodedPacket): void {
  if (!Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration <= 0) {
    throw new Error('ASR_CHUNK_PACKET_INVALID: Encoded audio packet timing is invalid.');
  }
  if (packet.timestamp < 0) {
    throw new Error('ASR_CHUNK_TIMELINE_UNSUPPORTED: Negative encoded audio packet timestamps are not qualified.');
  }
  if (packet.duration > DIRECT_ASR_CHUNK_DURATION_SECONDS) {
    throw new Error('ASR_CHUNK_PACKET_INVALID: One encoded audio packet exceeds the bounded chunk duration.');
  }
}

export async function extractR2LongFormAudioChunks(
  audioUrl: string,
  durationMs: number,
): Promise<SourceAudioChunk[]> {
  assertSource(audioUrl, durationMs);

  const input = new Input({
    source: new UrlSource(audioUrl, {
      maxCacheSize: 8 * 1024 * 1024,
      parallelism: 1,
    }),
    formats: ALL_FORMATS,
  });

  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('ASR_CHUNK_AUDIO_TRACK_UNAVAILABLE: Source media has no primary audio track.');

    const codec = await track.getCodec();
    if (codec !== 'aac') {
      throw new Error(`ASR_CHUNK_CODEC_UNSUPPORTED: Encoded packet passthrough currently requires AAC, got ${codec ?? 'unknown'}.`);
    }
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) {
      throw new Error('ASR_CHUNK_DECODER_CONFIG_UNAVAILABLE: AAC decoder metadata is missing.');
    }

    const sink = new EncodedPacketSink(track);
    const chunks: SourceAudioChunk[] = [];
    let packets: EncodedPacket[] = [];
    let chunkStartSeconds = 0;
    let chunkEndSeconds = 0;

    const flushChunk = async (): Promise<void> => {
      if (packets.length === 0) return;
      const target = new BufferTarget();
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target,
      });
      const source = new EncodedAudioPacketSource('aac');
      output.addAudioTrack(source);
      await output.start();
      try {
        for (let index = 0; index < packets.length; index += 1) {
          const packet = packets[index];
          const rebased = packet.clone({
            timestamp: packet.timestamp - chunkStartSeconds,
            sequenceNumber: index,
          });
          await source.add(rebased, index === 0 ? { decoderConfig } : undefined);
        }
        source.close();
        await output.finalize();
      } catch (error) {
        await output.cancel().catch(() => undefined);
        throw error;
      }

      const audio = target.buffer;
      if (!audio?.byteLength) {
        throw new Error('ASR_CHUNK_REMUX_EMPTY: Encoded AAC packet remux produced no data.');
      }
      const offsetMs = Math.round(chunkStartSeconds * 1000);
      const chunkDurationMs = Math.round((chunkEndSeconds - chunkStartSeconds) * 1000);
      if (chunkDurationMs <= 0 || chunkDurationMs > DIRECT_ASR_CHUNK_DURATION_MS) {
        throw new Error('ASR_CHUNK_DURATION_INVALID: Encoded packet chunk exceeded the bounded duration.');
      }
      if (offsetMs < 0 || offsetMs >= durationMs || offsetMs + chunkDurationMs > durationMs + 50) {
        throw new Error('ASR_CHUNK_TIMELINE_UNSUPPORTED: Encoded packet chunk exceeds the qualified source timeline.');
      }

      chunks.push({
        chunkId: `source:${chunks.length}`,
        audio,
        offsetMs,
        durationMs: Math.min(chunkDurationMs, durationMs - offsetMs),
        overlapBeforeMs: 0,
        overlapAfterMs: 0,
      });
      packets = [];
    };

    for await (const packet of sink.packets()) {
      assertPacketTimeline(packet);
      const endSeconds = packetEndSeconds(packet);
      if (packets.length === 0) {
        chunkStartSeconds = packet.timestamp;
        chunkEndSeconds = endSeconds;
        packets.push(packet);
        continue;
      }

      if (endSeconds - chunkStartSeconds > DIRECT_ASR_CHUNK_DURATION_SECONDS) {
        await flushChunk();
        chunkStartSeconds = packet.timestamp;
        chunkEndSeconds = endSeconds;
        packets.push(packet);
      } else {
        packets.push(packet);
        chunkEndSeconds = Math.max(chunkEndSeconds, endSeconds);
      }
    }
    await flushChunk();

    if (chunks.length === 0) {
      throw new Error('ASR_CHUNK_REMUX_EMPTY: Source audio produced no encoded AAC chunks.');
    }
    return chunks;
  } finally {
    input.dispose();
  }
}
