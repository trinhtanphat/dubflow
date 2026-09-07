import { Input, MP4, type Source } from 'mediabunny';

export type RemuxableSourceInfo = {
  codec: 'avc';
  durationSeconds: number;
};

function stableError(code: string, message: string) {
  return new Error(`${code}: ${message}`);
}

export function assertRemuxableVideoCodec(codec: string | null | undefined): asserts codec is 'avc' {
  if (codec !== 'avc') {
    throw stableError(
      'VIDEO_TRANSCODE_REQUIRED',
      `Source video codec ${codec ?? 'unknown'} cannot be packet-copied into the R2-only export path.`,
    );
  }
}

export async function assertRemuxableSource(source: Source): Promise<RemuxableSourceInfo> {
  const input = new Input({ source, formats: [MP4] });

  try {
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

    const videoTrack = videoTracks[0];
    const codec = await videoTrack.getCodec();
    assertRemuxableVideoCodec(codec);

    const durationSeconds = await videoTrack.computeDuration();
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw stableError('MP4_REMUX_FAILED', 'Source video duration is invalid.');
    }

    return { codec, durationSeconds };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.startsWith('VIDEO_TRANSCODE_REQUIRED:')
      || message.startsWith('MP4_REMUX_FAILED:')
    ) {
      throw error;
    }
    throw stableError('MP4_REMUX_FAILED', message);
  } finally {
    input.dispose();
  }
}
