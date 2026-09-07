import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserPiperClient,
  browserPiperAvailable,
  type PiperWorkerLike,
} from './browserPiperClient';
import type { PiperWorkerRequest, PiperWorkerResponse } from './browserPiperProtocol';

class FakeWorker implements PiperWorkerLike {
  messages: PiperWorkerRequest[] = [];
  terminated = false;
  private listeners = new Set<(event: MessageEvent<PiperWorkerResponse>) => void>();

  postMessage(message: PiperWorkerRequest) {
    this.messages.push(message);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<PiperWorkerResponse>) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<PiperWorkerResponse>) => void) {
    this.listeners.delete(listener);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data: PiperWorkerResponse) {
    const event = { data } as MessageEvent<PiperWorkerResponse>;
    for (const listener of this.listeners) listener(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserPiperAvailable', () => {
  it('requires Worker, WebAssembly, and OPFS', () => {
    vi.stubGlobal('Worker', class WorkerStub {});
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    expect(browserPiperAvailable()).toBe(true);

    vi.stubGlobal('Worker', undefined);
    expect(browserPiperAvailable()).toBe(false);
    vi.stubGlobal('Worker', class WorkerStub {});
    vi.stubGlobal('WebAssembly', undefined);
    expect(browserPiperAvailable()).toBe(false);
  });
});

describe('BrowserPiperClient', () => {
  it('creates one worker, initializes once, and reuses it for sequential synthesis', async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const client = new BrowserPiperClient(factory);

    const first = client.synthesize('xin chào');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.messages).toEqual([{ type: 'init' }]);
    worker.emit({ type: 'ready' });
    await Promise.resolve();
    const firstRequest = worker.messages[1];
    expect(firstRequest).toMatchObject({ type: 'synthesize', text: 'xin chào' });
    if (firstRequest.type !== 'synthesize') throw new Error('Expected synthesize request.');
    worker.emit({ type: 'result', requestId: firstRequest.requestId, pcm: new Uint8Array([1, 2]).buffer });
    await expect(first).resolves.toEqual(new Uint8Array([1, 2]));

    const second = client.synthesize('thế giới');
    await Promise.resolve();
    expect(worker.messages.filter((message) => message.type === 'init')).toHaveLength(1);
    const secondRequest = worker.messages.at(-1);
    if (!secondRequest || secondRequest.type !== 'synthesize') throw new Error('Expected second synthesize request.');
    worker.emit({ type: 'result', requestId: secondRequest.requestId, pcm: new Uint8Array([3, 4]).buffer });
    await expect(second).resolves.toEqual(new Uint8Array([3, 4]));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('ignores a mismatched result request id and correlates the active request', async () => {
    const worker = new FakeWorker();
    const client = new BrowserPiperClient(() => worker);
    const promise = client.synthesize('một');
    worker.emit({ type: 'ready' });
    await Promise.resolve();
    const request = worker.messages.at(-1);
    if (!request || request.type !== 'synthesize') throw new Error('Expected synthesize request.');

    let settled = false;
    promise.finally(() => { settled = true; });
    worker.emit({ type: 'result', requestId: 'wrong', pcm: new Uint8Array([9, 9]).buffer });
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.emit({ type: 'result', requestId: request.requestId, pcm: new Uint8Array([5, 6]).buffer });
    await expect(promise).resolves.toEqual(new Uint8Array([5, 6]));
  });

  it('preserves initialization failure code so Studio can fail the client lane closed', async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const client = new BrowserPiperClient(factory);
    const promise = client.synthesize('lỗi');
    worker.emit({ type: 'error', code: 'PIPER_INIT_FAILED', message: 'model unavailable' });
    await expect(promise).rejects.toMatchObject({
      name: 'BrowserPiperError',
      code: 'PIPER_INIT_FAILED',
      message: 'model unavailable',
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.messages).toEqual([{ type: 'init' }]);
  });

  it('surfaces progress and dispose terminates the worker', async () => {
    const worker = new FakeWorker();
    const progress = vi.fn();
    const client = new BrowserPiperClient(() => worker);
    const promise = client.synthesize('tiến độ', progress);
    worker.emit({ type: 'progress', loaded: 10, total: 100 });
    expect(progress).toHaveBeenCalledWith(10, 100);
    worker.emit({ type: 'ready' });
    await Promise.resolve();
    const request = worker.messages.at(-1);
    if (!request || request.type !== 'synthesize') throw new Error('Expected synthesize request.');
    worker.emit({ type: 'result', requestId: request.requestId, pcm: new Uint8Array([7, 8]).buffer });
    await promise;
    client.dispose();
    expect(worker.terminated).toBe(true);
  });
});
