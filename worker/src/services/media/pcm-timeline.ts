export type PcmTimelineConfig = {
  sampleRate: number;
  channels?: number;
  chunkSamples?: number;
};

export type PcmTimelineClip = {
  startMs: number;
  endMs: number;
  pcm: ArrayBuffer;
};

const BYTES_PER_SAMPLE = 2;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PCM_TIMELINE_INVALID: ${label} must be a positive integer.`);
  }
}

function wavHeader(sampleRate: number, channels: number, frames: number): Uint8Array {
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

export class PcmTimelineAssembler {
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly chunkSamples: number;
  private readonly blockAlign: number;

  constructor(config: PcmTimelineConfig) {
    assertPositiveInteger(config.sampleRate, 'sampleRate');
    assertPositiveInteger(config.channels ?? 1, 'channels');
    assertPositiveInteger(config.chunkSamples ?? 16_384, 'chunkSamples');
    this.sampleRate = config.sampleRate;
    this.channels = config.channels ?? 1;
    this.chunkSamples = config.chunkSamples ?? 16_384;
    this.blockAlign = this.channels * BYTES_PER_SAMPLE;
  }

  private framesForMs(milliseconds: number): number {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error('PCM_TIMELINE_INVALID: duration must be a finite non-negative number.');
    }
    return Math.round((milliseconds * this.sampleRate) / 1000);
  }

  private frameCount(byteLength: number): number {
    if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength % this.blockAlign !== 0) {
      throw new Error('PCM_TIMELINE_INVALID: PCM byte length is not aligned to the configured channel count.');
    }
    return byteLength / this.blockAlign;
  }

  durationMs(byteLength: number): number {
    return (this.frameCount(byteLength) / this.sampleRate) * 1000;
  }

  private fitFrames(pcm: ArrayBuffer, targetFrames: number): ArrayBuffer {
    if (!Number.isInteger(targetFrames) || targetFrames <= 0) {
      throw new Error('PCM_TIMELINE_INVALID: target clip duration must contain at least one sample frame.');
    }
    const sourceFrames = this.frameCount(pcm.byteLength);
    if (sourceFrames <= 0) throw new Error('PCM_TIMELINE_INVALID: source PCM clip is empty.');

    const source = new DataView(pcm);
    const output = new ArrayBuffer(targetFrames * this.blockAlign);
    const target = new DataView(output);
    for (let frame = 0; frame < targetFrames; frame += 1) {
      const sourceFrame = Math.min(sourceFrames - 1, Math.floor((frame * sourceFrames) / targetFrames));
      for (let channel = 0; channel < this.channels; channel += 1) {
        const sourceOffset = (sourceFrame * this.channels + channel) * BYTES_PER_SAMPLE;
        const targetOffset = (frame * this.channels + channel) * BYTES_PER_SAMPLE;
        target.setInt16(targetOffset, source.getInt16(sourceOffset, true), true);
      }
    }
    return output;
  }

  fitClip(pcm: ArrayBuffer, targetDurationMs: number): ArrayBuffer {
    return this.fitFrames(pcm, this.framesForMs(targetDurationMs));
  }

  streamTimeline(projectDurationMs: number, clips: PcmTimelineClip[]): ReadableStream<Uint8Array> {
    const totalFrames = this.framesForMs(projectDurationMs);
    if (totalFrames <= 0) throw new Error('PCM_TIMELINE_INVALID: project duration must contain at least one sample frame.');

    const normalized = clips.map((clip, index) => {
      const startFrame = this.framesForMs(clip.startMs);
      const endFrame = this.framesForMs(clip.endMs);
      if (endFrame <= startFrame) {
        throw new Error(`PCM_TIMELINE_INVALID: clip ${index} end must be after start.`);
      }
      if (endFrame > totalFrames) {
        throw new Error(`PCM_TIMELINE_INVALID: clip ${index} is outside the project timeline.`);
      }
      this.frameCount(clip.pcm.byteLength);
      return { ...clip, startFrame, endFrame };
    });

    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index].startFrame < normalized[index - 1].startFrame) {
        throw new Error('PCM_TIMELINE_INVALID: clips must be sorted by start time.');
      }
      if (normalized[index].startFrame < normalized[index - 1].endFrame) {
        throw new Error('PCM_TIMELINE_INVALID: clip windows must not overlap.');
      }
    }

    let headerPending = true;
    let cursorFrame = 0;
    let clipIndex = 0;
    let activeClip: Uint8Array | null = null;
    let activeClipOffset = 0;

    const enqueueActive = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
      if (!activeClip) throw new Error('PCM_TIMELINE_INVALID: active clip state is missing.');
      const chunkBytes = this.chunkSamples * this.blockAlign;
      const end = Math.min(activeClip.byteLength, activeClipOffset + chunkBytes);
      controller.enqueue(activeClip.subarray(activeClipOffset, end));
      activeClipOffset = end;
      if (activeClipOffset >= activeClip.byteLength) {
        const clip = normalized[clipIndex];
        cursorFrame = clip.endFrame;
        clipIndex += 1;
        activeClip = null;
        activeClipOffset = 0;
      }
    };

    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (headerPending) {
          headerPending = false;
          controller.enqueue(wavHeader(this.sampleRate, this.channels, totalFrames));
          return;
        }

        if (activeClip) {
          enqueueActive(controller);
          return;
        }

        const nextClip = normalized[clipIndex];
        if (nextClip && cursorFrame < nextClip.startFrame) {
          const frames = Math.min(this.chunkSamples, nextClip.startFrame - cursorFrame);
          controller.enqueue(new Uint8Array(frames * this.blockAlign));
          cursorFrame += frames;
          return;
        }

        if (nextClip && cursorFrame === nextClip.startFrame) {
          activeClip = new Uint8Array(this.fitFrames(nextClip.pcm, nextClip.endFrame - nextClip.startFrame));
          activeClipOffset = 0;
          enqueueActive(controller);
          return;
        }

        if (cursorFrame < totalFrames) {
          const frames = Math.min(this.chunkSamples, totalFrames - cursorFrame);
          controller.enqueue(new Uint8Array(frames * this.blockAlign));
          cursorFrame += frames;
          return;
        }

        controller.close();
      },
    });
  }
}
