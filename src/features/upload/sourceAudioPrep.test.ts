import { describe, expect, it } from 'vitest';
import * as sourceAudioPrep from './sourceAudioPrep';

type DecodeResult = {
  pcm: Float32Array;
  durationMs: number;
  sampleRate: number;
};

type DecodeSourceAudio = (
  file: File,
  workerFactory?: () => FakeDecodeWorker,
) => Promise<DecodeResult>;

class FakeDecodeWorker {
  private listeners = new Set<(event: MessageEvent<any>) => void>();
  terminated = false;
  messages: any[] = [];

  constructor(
    private readonly response: any = {
      type: 'decoded',
      durationMs: 2_000,
      sampleRate: 16_000,
      pcm: new Float32Array([0.25, -0.5, 0.75]).buffer,
    },
  ) {}

  addEventListener(_type: 'message', listener: (event: MessageEvent<any>) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<any>) => void) {
    this.listeners.delete(listener);
  }

  terminate() {
    this.terminated = true;
  }

  postMessage(message: any) {
    this.messages.push(message);
    queueMicrotask(() => {
      const data = { ...this.response, requestId: message.requestId };
      for (const listener of [...this.listeners]) listener({ data } as MessageEvent<any>);
    });
  }
}

function requireDecode(): DecodeSourceAudio {
  const candidate = (sourceAudioPrep as Record<string, unknown>).decodeSourceAudio;
  expect(typeof candidate).toBe('function');
  return candidate as DecodeSourceAudio;
}

describe('browser-local source audio decode', () => {
  it('materializes one transferable mono Float32 16 kHz buffer for an admitted source', async () => {
    const decodeSourceAudio = requireDecode();
    const worker = new FakeDecodeWorker();
    const file = new File([new Uint8Array(64)], 'source.mp4', { type: 'video/mp4' });

    const result = await decodeSourceAudio(file, () => worker);

    expect(worker.messages).toHaveLength(1);
    expect(worker.messages[0]).toMatchObject({ type: 'decode', file });
    expect(result.durationMs).toBe(2_000);
    expect(result.sampleRate).toBe(16_000);
    expect(result.pcm).toBeInstanceOf(Float32Array);
    expect(Array.from(result.pcm)).toEqual([0.25, -0.5, 0.75]);
    expect(worker.terminated).toBe(true);
  });

  it('rejects a source above 24 MiB before constructing the decode worker', async () => {
    const decodeSourceAudio = requireDecode();
    const file = new File(
      [new Uint8Array(24 * 1024 * 1024 + 1)],
      'oversize.mp4',
      { type: 'video/mp4' },
    );
    let workerCreated = false;

    await expect(decodeSourceAudio(file, () => {
      workerCreated = true;
      return new FakeDecodeWorker();
    })).rejects.toMatchObject({ code: 'LOCAL_SOURCE_DECODE_FAILED' });

    expect(workerCreated).toBe(false);
  });

  it('fails closed when worker decode is unavailable and always terminates the worker', async () => {
    const decodeSourceAudio = requireDecode();
    const worker = new FakeDecodeWorker({
      type: 'error',
      code: 'LOCAL_SOURCE_DECODE_FAILED',
      message: 'decode unavailable',
    });
    const file = new File([new Uint8Array(64)], 'unsupported.mkv', { type: 'video/x-matroska' });

    await expect(decodeSourceAudio(file, () => worker)).rejects.toMatchObject({
      code: 'LOCAL_SOURCE_DECODE_FAILED',
    });
    expect(worker.terminated).toBe(true);
  });

  it('rejects worker output that is not mono Float32 16 kHz bounded to five minutes', async () => {
    const decodeSourceAudio = requireDecode();
    const badRate = new FakeDecodeWorker({
      type: 'decoded',
      durationMs: 2_000,
      sampleRate: 48_000,
      pcm: new Float32Array([0]).buffer,
    });
    const file = new File([new Uint8Array(64)], 'source.mp4', { type: 'video/mp4' });

    await expect(decodeSourceAudio(file, () => badRate)).rejects.toMatchObject({
      code: 'LOCAL_SOURCE_DECODE_FAILED',
    });
    expect(badRate.terminated).toBe(true);
  });
});
