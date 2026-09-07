import { registerAacEncoder } from '@mediabunny/aac-encoder';
import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  canEncodeAudio,
} from 'mediabunny';
import type { R2MediaBucketLike } from '../../cloudflare/r2';
import { createR2MediaSource } from './r2-mediabunny-source';
import { createR2MultipartWritable } from './r2-multipart-target';
import { assertRemuxableVideoCodec } from './r2-remux';

export type R2Mp4RemuxSourceInfo = {
  codec: 'avc';
  videoTrackCount: number;
  durationSeconds: number;
};

export type PublishDubbedExportInput = {
  projectId: string;
  userId: string;
  sourceObjectKey: string;
  soundtrackObjectKey: string;
  targetLanguage: string;
  exportId: string;
  exportObjectKey: string;
};

export type R2Mp4RemuxPublisherOptions = {
  bucket: R2MediaBucketLike;
  partSize?: number;
};

let customAacEncoderRegistered = false;

function stableError(code: string, message: string, cause?: unknown) {
  const error = new Error(`${code}: ${message}`);
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isStableRemuxError(error: unknown) {
  const message = errorMessage(error);
  return (
    message.startsWith('VIDEO_TRANSCODE_REQUIRED:')
    || message.startsWith('AUDIO_ENCODE_FAILED:')
    || message.startsWith('MP4_REMUX_FAILED:')
    || message.startsWith('R2_EXPORT_WRITE_FAILED')
    || message.startsWith('R2_SOURCE_')
  );
}

async function mediaSource(bucket: R2MediaBucketLike, key: string) {
  if (!bucket.head || !bucket.get) {
    throw stableError('MP4_REMUX_FAILED', 'R2 head/get capability is unavailable.');
  }
  return createR2MediaSource(
    { head: bucket.head.bind(bucket), get: bucket.get.bind(bucket) },
    key,
  );
}

async function ensureAacEncoder() {
  if (await canEncodeAudio('aac')) return;

  if (!customAacEncoderRegistered) {
    registerAacEncoder();
    customAacEncoderRegistered = true;
  }

  if (!(await canEncodeAudio('aac'))) {
    throw stableError('AUDIO_ENCODE_FAILED', 'AAC encoder is unavailable.');
  }
}

async function inspectInput(input: Input): Promise<R2Mp4RemuxSourceInfo> {
  if (!(await input.canRead()) || (await input.getFormat()) !== MP4) {
    throw stableError('VIDEO_TRANSCODE_REQUIRED', 'Source must be a readable MP4 file.');
  }

  const videoTracks = await input.getVideoTracks();
  if (videoTracks.length !== 1) {
    throw stableError(
      'VIDEO_TRANSCODE_REQUIRED',
      `Source must contain exactly one video track; found ${videoTracks.length}.`,
    );
  }

  const codec = await videoTracks[0]!.getCodec();
  assertRemuxableVideoCodec(codec);
  const durationSeconds = await videoTracks[0]!.computeDuration();
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw stableError('MP4_REMUX_FAILED', 'Source video duration is invalid.');
  }

  return { codec, videoTrackCount: videoTracks.length, durationSeconds };
}

export async function inspectR2Mp4RemuxSource(
  bucket: R2MediaBucketLike,
  sourceObjectKey: string,
): Promise<R2Mp4RemuxSourceInfo> {
  const source = await mediaSource(bucket, sourceObjectKey);
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    return await inspectInput(input);
  } catch (error) {
    if (isStableRemuxError(error)) throw error;
    throw stableError('MP4_REMUX_FAILED', errorMessage(error), error);
  } finally {
    input.dispose();
  }
}

export class R2Mp4RemuxPublisher {
  private readonly bucket: R2MediaBucketLike;
  private readonly partSize?: number;

  constructor(options: R2Mp4RemuxPublisherOptions) {
    this.bucket = options.bucket;
    this.partSize = options.partSize;
  }

  async inspect(sourceObjectKey: string) {
    return inspectR2Mp4RemuxSource(this.bucket, sourceObjectKey);
  }

  async publishDubbedExport(input: PublishDubbedExportInput) {
    const sourceInput = new Input({
      source: await mediaSource(this.bucket, input.sourceObjectKey),
      formats: ALL_FORMATS,
    });
    const soundtrackInput = new Input({
      source: await mediaSource(this.bucket, input.soundtrackObjectKey),
      formats: ALL_FORMATS,
    });

    let output: Output | null = null;
    let finalized = false;

    try {
      await inspectInput(sourceInput);
      const videoTrack = await sourceInput.getPrimaryVideoTrack();
      if (!videoTrack) {
        throw stableError('VIDEO_TRANSCODE_REQUIRED', 'Source video track is unavailable.');
      }

      const decoderConfig = await videoTrack.getDecoderConfig();
      if (!decoderConfig) {
        throw stableError('MP4_REMUX_FAILED', 'Source AVC decoder configuration is unavailable.');
      }

      if (!(await soundtrackInput.canRead())) {
        throw stableError('AUDIO_ENCODE_FAILED', 'Dubbed soundtrack is unreadable.');
      }
      const dubbedAudioTrack = await soundtrackInput.getPrimaryAudioTrack();
      if (!dubbedAudioTrack) {
        throw stableError('AUDIO_ENCODE_FAILED', 'Dubbed soundtrack has no audio track.');
      }

      await ensureAacEncoder();

      const multipart = await createR2MultipartWritable(
        this.bucket,
        input.exportObjectKey,
        this.partSize === undefined ? {} : { partSize: this.partSize },
      );
      const videoSource = new EncodedVideoPacketSource('avc');
      const audioSource = new AudioSampleSource({ codec: 'aac', bitrate: 128_000 });

      output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
        target: new StreamTarget(multipart.writable),
      });
      output.addVideoTrack(videoSource, { decoderConfig });
      output.addAudioTrack(audioSource);
      await output.start();

      const pumpVideo = async () => {
        const sink = new EncodedPacketSink(videoTrack);
        let first = true;
        for await (const packet of sink.packets()) {
          await videoSource.add(packet, first ? { decoderConfig } : undefined);
          first = false;
        }
        videoSource.close();
      };

      const pumpAudio = async () => {
        try {
          const sink = new AudioSampleSink(dubbedAudioTrack);
          for await (const sample of sink.samples()) {
            try {
              await audioSource.add(sample);
            } finally {
              sample.close();
            }
          }
          audioSource.close();
        } catch (error) {
          if (isStableRemuxError(error)) throw error;
          throw stableError('AUDIO_ENCODE_FAILED', errorMessage(error), error);
        }
      };

      // Feed both tracks concurrently so fragmented MP4 buffering remains bounded
      // instead of retaining an entire long-form video while waiting for audio.
      await Promise.all([pumpVideo(), pumpAudio()]);
      await output.finalize();
      finalized = true;
      await multipart.complete();

      return { exportObjectKey: input.exportObjectKey };
    } catch (error) {
      if (output && !finalized) {
        try {
          await output.cancel();
        } catch {
          // Keep the original stable failure instead of masking it with cleanup.
        }
      }
      if (isStableRemuxError(error)) throw error;
      throw stableError('MP4_REMUX_FAILED', errorMessage(error), error);
    } finally {
      sourceInput.dispose();
      soundtrackInput.dispose();
    }
  }
}
