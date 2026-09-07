import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { R2Mp4RemuxPublisher, inspectR2Mp4RemuxSource } from '../src/services/media/mp4-remux';
import { decodeBase64, H264_AAC_MP4_BASE64, makePcm16Wav, VP9_WEBM_BASE64 } from './fixtures/r2-remux-fixtures';

type BytesMap = Map<string, Uint8Array>;

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function memoryBucket(initial: Record<string, Uint8Array>) {
  const objects: BytesMap = new Map(Object.entries(initial));
  return {
    objects,
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { key, size: bytes.byteLength, httpMetadata: { contentType: key.endsWith('.wav') ? 'audio/wav' : 'video/mp4' } } : null;
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const range = options?.range ?? { offset: 0, length: bytes.byteLength };
      const selected = bytes.slice(range.offset, range.offset + range.length);
      return {
        key,
        size: bytes.byteLength,
        range,
        httpMetadata: { contentType: key.endsWith('.wav') ? 'audio/wav' : 'video/mp4' },
        body: body(selected),
      };
    },
    async createMultipartUpload(key: string) {
      const parts = new Map<number, Uint8Array>();
      return {
        key,
        uploadId: `upload:${key}`,
        async uploadPart(partNumber: number, value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream) {
          if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) throw new Error('fixture expects byte parts');
          const bytes = value instanceof ArrayBuffer
            ? new Uint8Array(value.slice(0))
            : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
          parts.set(partNumber, bytes);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(input: Array<{ partNumber: number; etag: string }>) {
          const ordered = input.map((part) => parts.get(part.partNumber) ?? new Uint8Array());
          const length = ordered.reduce((sum, part) => sum + part.byteLength, 0);
          const combined = new Uint8Array(length);
          let offset = 0;
          for (const part of ordered) {
            combined.set(part, offset);
            offset += part.byteLength;
          }
          objects.set(key, combined);
          return { key, size: combined.byteLength };
        },
        async abort() {
          parts.clear();
        },
      };
    },
    resumeMultipartUpload() {
      throw new Error('not used');
    },
  };
}

async function firstVideoPacket(bytes: Uint8Array): Promise<Uint8Array> {
  using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('fixture video track missing');
  const packet = await new EncodedPacketSink(track).getFirstPacket();
  if (!packet) throw new Error('fixture video packet missing');
  return packet.data.slice();
}

describe('R2-only MP4 remux', () => {
  it('admits baseline AVC and rejects sources that require video transcoding', async () => {
    const bucket = memoryBucket({
      'source.mp4': decodeBase64(H264_AAC_MP4_BASE64),
      'vp9.webm': decodeBase64(VP9_WEBM_BASE64),
    });

    await expect(inspectR2Mp4RemuxSource(bucket as never, 'source.mp4'))
      .resolves.toMatchObject({ codec: 'avc', videoTrackCount: 1 });
    await expect(inspectR2Mp4RemuxSource(bucket as never, 'vp9.webm'))
      .rejects.toThrow(/VIDEO_TRANSCODE_REQUIRED/);
  });

  it('copies the encoded AVC video track, drops source audio, AAC-encodes dubbed PCM, and writes final MP4 to R2', async () => {
    const source = decodeBase64(H264_AAC_MP4_BASE64);
    const bucket = memoryBucket({
      'projects/p1/source/movie.mp4': source,
      'projects/p1/exports/e1/soundtrack.wav': makePcm16Wav(),
    });
    const publisher = new R2Mp4RemuxPublisher({ bucket: bucket as never, partSize: 5 * 1024 * 1024 });

    await expect(publisher.publishDubbedExport({
      projectId: 'p1',
      userId: 'dev-user',
      sourceObjectKey: 'projects/p1/source/movie.mp4',
      soundtrackObjectKey: 'projects/p1/exports/e1/soundtrack.wav',
      targetLanguage: 'vi',
      exportId: 'e1',
      exportObjectKey: 'projects/p1/exports/e1/dubbed.mp4',
    })).resolves.toEqual({ exportObjectKey: 'projects/p1/exports/e1/dubbed.mp4' });

    const outputBytes = bucket.objects.get('projects/p1/exports/e1/dubbed.mp4');
    expect(outputBytes?.byteLength).toBeGreaterThan(0);
    using output = new Input({ source: new BufferSource(outputBytes!), formats: ALL_FORMATS });
    const videoTracks = await output.getVideoTracks();
    const audioTracks = await output.getAudioTracks();
    expect(videoTracks).toHaveLength(1);
    expect(audioTracks).toHaveLength(1);
    expect(await videoTracks[0]!.getCodec()).toBe('avc');
    expect(await audioTracks[0]!.getCodec()).toBe('aac');
    expect(await firstVideoPacket(outputBytes!)).toEqual(await firstVideoPacket(source));
    const audioDuration = await audioTracks[0]!.computeDuration();
    expect(audioDuration).toBeGreaterThan(0.45);
    expect(audioDuration).toBeLessThan(0.8);
  });
});
