import { describe, expect, it, vi } from 'vitest';
import type { BrowserPiperRuntime } from '../features/voice/browserPiper';
import { ensureClientVoiceForExport } from './StudioShell';

function runtime(supported = true): BrowserPiperRuntime {
  return {
    isSupported: () => supported,
    ensureModel: vi.fn(async () => {}),
    synthesize: vi.fn(async () => new Blob(['wav'])),
  };
}

describe('Studio browser Piper export preflight', () => {
  it('runs the Vietnamese cache preflight for dubbed vi before launch code can continue', async () => {
    const ensure = vi.fn(async () => {});
    const onState = vi.fn();

    await ensureClientVoiceForExport({
      projectId: 'p1',
      language: 'vi',
      output: 'dubbed',
      runtime: runtime(),
      decodeWav: vi.fn(async () => new Uint8Array([1, 2])),
      onState,
      ensure,
    });

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1',
      onState,
    }));
  });

  it('skips local voice preload for subtitles and non-vi targets', async () => {
    const ensure = vi.fn(async () => {});
    const common = {
      projectId: 'p1',
      runtime: runtime(),
      decodeWav: vi.fn(async () => new Uint8Array([1, 2])),
      ensure,
    };

    await ensureClientVoiceForExport({ ...common, language: 'vi', output: 'subtitles' });
    await ensureClientVoiceForExport({ ...common, language: 'ja', output: 'dubbed' });

    expect(ensure).not.toHaveBeenCalled();
  });

  it('fails closed before preload when the local browser runtime is unsupported', async () => {
    const ensure = vi.fn(async () => {});

    await expect(ensureClientVoiceForExport({
      projectId: 'p1',
      language: 'vi',
      output: 'dubbed',
      runtime: runtime(false),
      decodeWav: vi.fn(async () => new Uint8Array([1, 2])),
      ensure,
    })).rejects.toThrow('chưa hỗ trợ giọng Việt cục bộ');

    expect(ensure).not.toHaveBeenCalled();
  });

  it('propagates preload failure so callers cannot fall through to export launch', async () => {
    const ensure = vi.fn(async () => { throw new Error('local model failed'); });

    await expect(ensureClientVoiceForExport({
      projectId: 'p1',
      language: 'vi',
      output: 'dubbed',
      runtime: runtime(),
      decodeWav: vi.fn(async () => new Uint8Array([1, 2])),
      ensure,
    })).rejects.toThrow('local model failed');
  });
});
