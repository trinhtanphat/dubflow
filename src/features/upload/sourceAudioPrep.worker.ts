/// <reference lib="webworker" />

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  WavOutputFormat,
} from 'mediabunny';

type PrepWorkerRequest =
  | { type: 'inspect'; requestId: string; file: File }
  | { type: 'prepare-chunk'; requestId: string; file: File; startMs: number; endMs: number };

type PrepWorkerResponse =
  | { type: 'inspection'; requestId: string; durationMs: number }
  | { type: 'chunk'; requestId: string; wav: ArrayBuffer; durationMs: number }
  | { type: 'error'; requestId: string; code: string; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

function mediaInput(file: File) {
  return new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
}

async function inspectSource(file: File): Promise<number> {
  const input = mediaInput(file);
  if (!(await input.canRead())) throw new Error('Source media format is not readable.');
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) throw new Error('Source media has no audio track.');
  if (!(await audioTrack.canDecode())) throw new Error('Source audio codec cannot be decoded in this browser.');
  const durationSeconds = await input.computeDuration([audioTrack]);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Source audio duration is invalid.');
  return Math.round(durationSeconds * 1000);
}

async function prepareChunk(file: File, startMs: number, endMs: number): Promise<ArrayBuffer> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    throw new Error('Prepared audio trim bounds are invalid.');
  }
  if (endMs - startMs > 300_000) throw new Error('Prepared audio chunk exceeds 300 seconds.');

  const input = mediaInput(file);
  const target = new BufferTarget();
  const output = new Output({
    format: new WavOutputFormat(),
    target,
  });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    video: { discard: true },
    audio: {
      codec: 'pcm-s16',
      numberOfChannels: 1,
      sampleRate: 16_000,
      sampleFormat: 's16',
      forceTranscode: true,
    },
    trim: {
      start: startMs / 1000,
      end: endMs / 1000,
    },
  });
  if (!conversion.isValid) throw new Error('Browser cannot convert the selected source audio to PCM WAV.');
  await conversion.execute();
  const wav = target.buffer;
  if (!wav || wav.byteLength <= 44) throw new Error('Browser audio conversion produced an empty WAV chunk.');
  return wav;
}

scope.addEventListener('message', (event: MessageEvent<PrepWorkerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.type === 'inspect') {
        const durationMs = await inspectSource(request.file);
        scope.postMessage({ type: 'inspection', requestId: request.requestId, durationMs } satisfies PrepWorkerResponse);
        return;
      }

      const wav = await prepareChunk(request.file, request.startMs, request.endMs);
      const response = {
        type: 'chunk',
        requestId: request.requestId,
        wav,
        durationMs: request.endMs - request.startMs,
      } satisfies PrepWorkerResponse;
      scope.postMessage(response, [wav]);
    } catch (error) {
      scope.postMessage({
        type: 'error',
        requestId: request.requestId,
        code: request.type === 'inspect' ? 'SOURCE_AUDIO_UNAVAILABLE' : 'SOURCE_AUDIO_CHUNK_FAILED',
        message: error instanceof Error ? error.message : 'Browser source audio preparation failed.',
      } satisfies PrepWorkerResponse);
    }
  })();
});
