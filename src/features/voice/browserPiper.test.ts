import { describe, expect, it, vi } from 'vitest';
import {
  VIETNAMESE_PIPER_VOICE_ID,
  createBrowserPiperRuntime,
  type PiperModule,
} from './browserPiper';

describe('browser Piper runtime', () => {
  it('maps model download progress and uses the exact Vietnamese voice', async () => {
    const download = vi.fn(async (_voiceId: string, onProgress?: (progress: { loaded?: number; total?: number; url?: string }) => void) => {
      onProgress?.({ loaded: 42, total: 100, url: 'model.onnx' });
    });
    const module: PiperModule = { download, predict: vi.fn() };
    const runtime = createBrowserPiperRuntime({ loader: async () => module, supported: () => true });
    const progress: Array<number | null> = [];

    await runtime.ensureModel((value) => progress.push(value.percent));

    expect(download).toHaveBeenCalledWith(VIETNAMESE_PIPER_VOICE_ID, expect.any(Function));
    expect(progress).toEqual([42]);
  });

  it('synthesizes trimmed text with the exact Vietnamese voice id', async () => {
    const wav = new Blob(['wav'], { type: 'audio/wav' });
    const predict = vi.fn(async () => wav);
    const module: PiperModule = { download: vi.fn(), predict };
    const runtime = createBrowserPiperRuntime({ loader: async () => module, supported: () => true });

    await expect(runtime.synthesize('  Xin chào  ')).resolves.toBe(wav);
    expect(predict).toHaveBeenCalledWith(
      { text: 'Xin chào', voiceId: VIETNAMESE_PIPER_VOICE_ID },
      expect.any(Function),
    );
  });

  it('fails closed when the browser runtime is unsupported', async () => {
    const loader = vi.fn(async () => ({ download: vi.fn(), predict: vi.fn() } as PiperModule));
    const runtime = createBrowserPiperRuntime({ loader, supported: () => false });

    expect(runtime.isSupported()).toBe(false);
    await expect(runtime.ensureModel()).rejects.toThrow('chưa hỗ trợ giọng Việt cục bộ');
    await expect(runtime.synthesize('Xin chào')).rejects.toThrow('chưa hỗ trợ giọng Việt cục bộ');
    expect(loader).not.toHaveBeenCalled();
  });
});
