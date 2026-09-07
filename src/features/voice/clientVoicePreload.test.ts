import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { TranslationVariantDto } from '../translation/languageVariantsApi';
import type { BrowserPiperRuntime } from './browserPiper';
import {
  canonicalClientVoiceObjectKey,
  type ClientVoiceUploadResult,
} from './clientVoiceApi';
import { ensureVietnameseClientVoiceCache } from './clientVoicePreload';

function row(version = 1, objectKey: string | null = null): TranslationVariantDto {
  return {
    segmentId: 's1',
    speakerId: null,
    startMs: 0,
    endMs: 1000,
    sourceText: 'hello',
    sourceVersion: 1,
    translation: {
      segmentId: 's1',
      projectId: 'p1',
      targetLanguage: 'vi',
      translatedText: version === 1 ? 'xin chào' : 'xin chào mới',
      translationEngine: 'test',
      translationStatus: 'completed',
      translationContextRevision: null,
      voiceStatus: objectKey ? 'completed' : 'pending',
      dubbedObjectKey: objectKey,
      version,
    },
  };
}

function runtime(): BrowserPiperRuntime {
  return {
    isSupported: () => true,
    ensureModel: vi.fn(async () => {}),
    synthesize: vi.fn(async () => new Blob(['wav'])),
  };
}

function uploadResult(version: number): ClientVoiceUploadResult {
  return {
    targetLanguage: 'vi',
    segmentId: 's1',
    version,
    voiceStatus: 'completed',
    objectKey: canonicalClientVoiceObjectKey('p1', 's1', version),
  };
}

describe('Vietnamese client voice preload', () => {
  it('does zero model work when the exact cache is already complete', async () => {
    const complete = row(1, canonicalClientVoiceObjectKey('p1', 's1', 1));
    const piper = runtime();
    const getVariants = vi.fn(async () => [complete]);
    const upload = vi.fn();

    await ensureVietnameseClientVoiceCache({ projectId: 'p1', runtime: piper, decodeWav: vi.fn() }, { getVariants, upload });

    expect(piper.ensureModel).not.toHaveBeenCalled();
    expect(piper.synthesize).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('synthesizes misses sequentially and verifies exact cache metadata', async () => {
    const piper = runtime();
    const second: TranslationVariantDto = { ...row(), segmentId: 's2', translation: { ...row().translation!, segmentId: 's2' } };
    const initial = [row(), second];
    const final = initial.map((item) => ({
      ...item,
      translation: {
        ...item.translation!,
        voiceStatus: 'completed',
        dubbedObjectKey: canonicalClientVoiceObjectKey('p1', item.segmentId, item.translation!.version),
      },
    }));
    const getVariants = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(final);
    const order: string[] = [];
    (piper.synthesize as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      order.push(`synth:${text}`);
      return new Blob(['wav']);
    });
    const decodeWav = vi.fn(async () => new Uint8Array([1, 2]));
    const upload = vi.fn(async (input: { segmentId: string; version: number }) => {
      order.push(`upload:${input.segmentId}`);
      return { ...uploadResult(input.version), segmentId: input.segmentId, objectKey: canonicalClientVoiceObjectKey('p1', input.segmentId, input.version) };
    });

    await ensureVietnameseClientVoiceCache({ projectId: 'p1', runtime: piper, decodeWav }, { getVariants, upload });

    expect(order).toEqual(['synth:xin chào', 'upload:s1', 'synth:xin chào', 'upload:s2']);
    expect(getVariants).toHaveBeenCalledTimes(2);
  });

  it('refetches and retries a version conflict exactly once', async () => {
    const piper = runtime();
    const initial = row(1);
    const current = row(2);
    const complete = row(2, canonicalClientVoiceObjectKey('p1', 's1', 2));
    const getVariants = vi.fn()
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([current])
      .mockResolvedValueOnce([complete]);
    const upload = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, 'TRANSLATION_VARIANT_CONFLICT', 'changed'))
      .mockResolvedValueOnce(uploadResult(2));

    await ensureVietnameseClientVoiceCache({
      projectId: 'p1',
      runtime: piper,
      decodeWav: async () => new Uint8Array([1, 2]),
    }, { getVariants, upload });

    expect(piper.synthesize).toHaveBeenCalledTimes(2);
    expect(piper.synthesize).toHaveBeenNthCalledWith(1, 'xin chào');
    expect(piper.synthesize).toHaveBeenNthCalledWith(2, 'xin chào mới');
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a second version conflict', async () => {
    const piper = runtime();
    const getVariants = vi.fn()
      .mockResolvedValueOnce([row(1)])
      .mockResolvedValueOnce([row(2)]);
    const upload = vi.fn().mockRejectedValue(new ApiError(409, 'TRANSLATION_VARIANT_CONFLICT', 'changed'));

    await expect(ensureVietnameseClientVoiceCache({
      projectId: 'p1',
      runtime: piper,
      decodeWav: async () => new Uint8Array([1, 2]),
    }, { getVariants, upload })).rejects.toMatchObject({ code: 'TRANSLATION_VARIANT_CONFLICT' });

    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('fails before model work when translations are incomplete', async () => {
    const incomplete = row();
    incomplete.translation = { ...incomplete.translation!, translationStatus: 'pending' };
    const piper = runtime();

    await expect(ensureVietnameseClientVoiceCache({
      projectId: 'p1',
      runtime: piper,
      decodeWav: async () => new Uint8Array([1, 2]),
    }, { getVariants: async () => [incomplete], upload: vi.fn() })).rejects.toThrow('chưa hoàn tất');

    expect(piper.ensureModel).not.toHaveBeenCalled();
  });

  it('fails final verification when metadata is still stale', async () => {
    const piper = runtime();
    const getVariants = vi.fn().mockResolvedValueOnce([row()]).mockResolvedValueOnce([row()]);

    await expect(ensureVietnameseClientVoiceCache({
      projectId: 'p1',
      runtime: piper,
      decodeWav: async () => new Uint8Array([1, 2]),
    }, { getVariants, upload: async () => uploadResult(1) })).rejects.toThrow('chưa hoàn tất sau khi upload');
  });
});
