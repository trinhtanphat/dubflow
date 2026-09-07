import type { R2BucketLike } from '../../cloudflare/r2';
import { PcmTimelineAssembler, type PcmTimelineConfig } from './pcm-timeline';

export type PcmSoundtrackClip = {
  startMs: number;
  endMs: number;
  objectKey: string;
};

export type StorePcmSoundtrackInput = {
  projectId: string;
  targetLanguage: string;
  exportId: string;
  durationMs: number;
  clips: PcmSoundtrackClip[];
};

const DEFAULT_PCM_CONFIG: PcmTimelineConfig = {
  sampleRate: 24_000,
  channels: 1,
};

export class PcmSoundtrackService {
  private readonly assembler: PcmTimelineAssembler;

  constructor(
    private readonly bucket: R2BucketLike,
    config: PcmTimelineConfig = DEFAULT_PCM_CONFIG,
  ) {
    this.assembler = new PcmTimelineAssembler(config);
  }

  async durationSeconds(objectKey: string): Promise<number> {
    if (!this.bucket.head) throw new Error('PCM_BUCKET_UNAVAILABLE: R2 head is unavailable.');
    const object = await this.bucket.head(objectKey);
    if (!object) throw new Error(`PCM_ARTIFACT_MISSING: ${objectKey}`);
    return this.assembler.durationMs(object.size) / 1000;
  }

  async storeSoundtrack(input: StorePcmSoundtrackInput): Promise<string> {
    if (!this.bucket.get || !this.bucket.put) {
      throw new Error('PCM_BUCKET_UNAVAILABLE: R2 get/put is unavailable.');
    }

    const outputKey = `projects/${input.projectId}/soundtracks/${input.targetLanguage}/${input.exportId}.wav`;
    const stream = this.assembler.streamTimeline(
      input.durationMs,
      input.clips.map((clip) => ({
        startMs: clip.startMs,
        endMs: clip.endMs,
        pcm: async () => {
          const object = await this.bucket.get!(clip.objectKey);
          if (!object) throw new Error(`PCM_ARTIFACT_MISSING: ${clip.objectKey}`);
          return new Response(object.body).arrayBuffer();
        },
      })),
    );

    await this.bucket.put(outputKey, stream, {
      httpMetadata: { contentType: 'audio/wav' },
    });
    return outputKey;
  }
}
