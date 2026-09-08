/// <reference lib="webworker" />

import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  NullTarget,
  Output,
  WavOutputFormat,
} from 'mediabunny';

const LOCAL_SOURCE_MAX_DURATION_MS = 300_000;
const LOCAL_SOURCE_SAMPLE_RATE = 16_000;

type DecodeWorkerRequest = {
  type: 'decode';
  requestId: string;
  file: File;
};

type DecodeWorkerResponse =
  | {
      type: 'decoded';
      requestId: string;
      pcm: ArrayBuffer;
      durationMs: number;
      sampleRate: number;
    }
  | {
      type: 'error';
      requestId: string;
      code: 'LOCAL_SOURCE_DECODE_FAILED';
      message: string;
    };

const scope = self as unknown as DedicatedWorkerGlobalScope;

function mediaInput(file: File) {
  return new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
}

async function decodeSource(file: File): Promise<{ pcm: Float32Array; durationMs: number }> {
  const input = mediaInput(file);
  try {
    if (!(await input.canRead())) throw new Error('Source media format is not readable.');
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) throw new Error('Source media has no audio track.');
    if (!(await audioTrack.canDecode())) throw new Error('Source audio codec cannot be decoded in this browser.');

    const sourceDurationSeconds = await input.computeDuration([audioTrack]);
    const sourceDurationMs = Math.round(sourceDurationSeconds * 1000);
    if (
      !Number.isFinite(sourceDurationMs)
      || sourceDurationMs <= 0
      || sourceDurationMs > LOCAL_SOURCE_MAX_DURATION_MS
    ) {
      throw new Error('Source audio duration exceeds the browser-local boundary.');
    }

    const chunks: Float32Array[] = [];
    let totalFrames = 0;
    const output = new Output({
      format: new WavOutputFormat(),
      target: new NullTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { discard: true },
      audio: {
        codec: 'pcm-f32',
        numberOfChannels: 1,
        sampleRate: LOCAL_SOURCE_SAMPLE_RATE,
        sampleFormat: 'f32',
        forceTranscode: true,
        process: (sample) => {
          if (sample.numberOfChannels !== 1 || sample.sampleRate !== LOCAL_SOURCE_SAMPLE_RATE) {
            throw new Error('Decoded audio does not satisfy the mono 16 kHz contract.');
          }
          const options = { format: 'f32' as const, planeIndex: 0 };
          const floats = new Float32Array(sample.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT);
          sample.copyTo(floats, options);
          if (floats.length > 0) {
            chunks.push(floats);
            totalFrames += floats.length;
          }
          return sample;
        },
      },
      tags: {},
      showWarnings: false,
    });

    if (!conversion.isValid) {
      throw new Error('Browser cannot decode the selected source audio.');
    }
    await conversion.execute();

    if (totalFrames <= 0) throw new Error('Browser audio decode produced no PCM samples.');
    const pcmDurationMs = Math.round(totalFrames / LOCAL_SOURCE_SAMPLE_RATE * 1000);
    if (pcmDurationMs <= 0 || pcmDurationMs > LOCAL_SOURCE_MAX_DURATION_MS) {
      throw new Error('Decoded PCM duration exceeds the browser-local boundary.');
    }

    const pcm = new Float32Array(totalFrames);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }

    return { pcm, durationMs: sourceDurationMs };
  } finally {
    input.dispose();
  }
}

scope.addEventListener('message', (event: MessageEvent<DecodeWorkerRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'decode') return;

  void (async () => {
    try {
      const { pcm, durationMs } = await decodeSource(request.file);
      const response = {
        type: 'decoded',
        requestId: request.requestId,
        pcm: pcm.buffer,
        durationMs,
        sampleRate: LOCAL_SOURCE_SAMPLE_RATE,
      } satisfies DecodeWorkerResponse;
      scope.postMessage(response, [pcm.buffer]);
    } catch {
      scope.postMessage({
        type: 'error',
        requestId: request.requestId,
        code: 'LOCAL_SOURCE_DECODE_FAILED',
        message: 'Browser source audio decode failed.',
      } satisfies DecodeWorkerResponse);
    }
  })();
});
