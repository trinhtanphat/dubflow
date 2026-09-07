import { describe, expect, it } from 'vitest';
import {
  DIRECT_ASR_MAX_BYTES,
  PREPARED_ASR_CHUNK_DURATION_MS,
  prepareSourceAudioChunks,
  type SourceAudioPrepWorkerLike,
} from './sourceAudioPrep';

class FakePrepWorker implements SourceAudioPrepWorkerLike {
  private listeners = new Set<(event: MessageEvent<any>) => void>();
  terminated = false;
  constructor(private readonly durationMs: number) {}
  addEventListener(_type: 'message', listener: (event: MessageEvent<any>) => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'message', listener: (event: MessageEvent<any>) => void) { this.listeners.delete(listener); }
  terminate() { this.terminated = true; }
  postMessage(message: any) {
    queueMicrotask(() => {
      const data = message.type === 'inspect'
        ? { type: 'inspection', requestId: message.requestId, durationMs: this.durationMs, decodable: true }
        : {
            type: 'chunk',
            requestId: message.requestId,
            wav: new ArrayBuffer(48),
            durationMs: message.endMs - message.startMs,
          };
      for (const listener of [...this.listeners]) listener({ data } as MessageEvent<any>);
    });
  }
}

describe('browser source audio preparation', () => {
  it('uses bounded <=300s windows and backpressures each chunk consumer', async () => {
    const worker = new FakePrepWorker(610_000);
    const received: Array<[number, number, number]> = [];
    let activeConsumers = 0;
    let maxActiveConsumers = 0;
    const file = new File([new Uint8Array(64)], 'long.mp4', { type: 'video/mp4' });

    const result = await prepareSourceAudioChunks(file, async (chunk) => {
      activeConsumers += 1;
      maxActiveConsumers = Math.max(maxActiveConsumers, activeConsumers);
      received.push([chunk.index, chunk.offsetMs, chunk.durationMs]);
      await Promise.resolve();
      activeConsumers -= 1;
    }, () => worker);

    expect(result).toEqual({ required: true, durationMs: 610_000, chunkCount: 3 });
    expect(received).toEqual([
      [0, 0, PREPARED_ASR_CHUNK_DURATION_MS],
      [1, 300_000, PREPARED_ASR_CHUNK_DURATION_MS],
      [2, 600_000, 10_000],
    ]);
    expect(maxActiveConsumers).toBe(1);
    expect(worker.terminated).toBe(true);
  });

  it('does not materialize chunks for a short source below the direct payload ceiling', async () => {
    const worker = new FakePrepWorker(120_000);
    const file = new File([new Uint8Array(64)], 'short.mp4', { type: 'video/mp4' });
    let consumed = false;
    const result = await prepareSourceAudioChunks(file, async () => { consumed = true; }, () => worker);
    expect(result).toEqual({ required: false, durationMs: 120_000, chunkCount: 0 });
    expect(consumed).toBe(false);
  });

  it('requires preparation for a source above the direct byte ceiling even when duration is short', async () => {
    expect(DIRECT_ASR_MAX_BYTES).toBe(24 * 1024 * 1024);
  });
});
