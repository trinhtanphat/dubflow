import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { TranslationVariantDto } from '../translation/languageVariantsApi';
import {
  PIPER_VI_VOICE_ID,
  prepareVietnameseClientVoiceCache,
  type ClientPiperVoiceServices,
} from './clientPiperVoice';

function variant(
  segmentId: string,
  version: number,
  overrides: Partial<NonNullable<TranslationVariantDto['translation']>> = {},
): TranslationVariantDto {
  return {
    segmentId,
    startMs: 0,
    endMs: 1000,
    sourceText: 'hello',
    speakerId: null,
    translation: {
      targetLanguage: 'vi',
      translatedText: `Xin chào ${segmentId}`,
      translationEngine: 'workers-ai',
      translationStatus: 'completed',
      translationContextRevision: 1,
      voiceStatus: 'pending',
      dubbedObjectKey: null,
      version,
      ...overrides,
    },
  };
}

function services(rows: TranslationVariantDto[], events: string[] = []): ClientPiperVoiceServices {
  return {
    getVariants: vi.fn(async (projectId) => {
      events.push(`variants:${projectId}`);
      return rows;
    }),
    synthesize: vi.fn(async (text, voiceId) => {
      events.push(`synthesize:${text}:${voiceId}`);
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    }),
    convert: vi.fn((wav) => {
      events.push(`convert:${wav.byteLength}`);
      return new Uint8Array([0, 0, 1, 0]);
    }),
    upload: vi.fn(async (projectId, segmentId, version, pcm) => {
      events.push(`upload:${projectId}:${segmentId}:${version}:${pcm.byteLength}`);
      return {
        targetLanguage: 'vi' as const,
        segmentId,
        version,
        voiceStatus: 'completed',
        objectKey: `projects/${projectId}/voices/vi/${segmentId}/${version}.pcm`,
      };
    }),
  };
}

describe('browser Piper Vietnamese cache preload', () => {
  it('reuses an exact current-version cache entry without synthesis or upload', async () => {
    const row = variant('s1', 3, {
      voiceStatus: 'completed',
      dubbedObjectKey: 'projects/p1/voices/vi/s1/3.pcm',
    });
    const deps = services([row]);

    await expect(prepareVietnameseClientVoiceCache('p1', deps)).resolves.toEqual({ synthesized: 0, reused: 1 });
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('synthesizes only missing or stale variants sequentially with the pinned Vietnamese voice', async () => {
    const events: string[] = [];
    const deps = services([
      variant('cached', 2, {
        voiceStatus: 'completed',
        dubbedObjectKey: 'projects/p1/voices/vi/cached/2.pcm',
      }),
      variant('stale', 4, {
        voiceStatus: 'completed',
        dubbedObjectKey: 'projects/p1/voices/vi/stale/3.pcm',
      }),
      variant('missing', 5),
    ], events);

    await expect(prepareVietnameseClientVoiceCache('p1', deps)).resolves.toEqual({ synthesized: 2, reused: 1 });
    expect(deps.synthesize).toHaveBeenNthCalledWith(1, 'Xin chào stale', PIPER_VI_VOICE_ID);
    expect(deps.synthesize).toHaveBeenNthCalledWith(2, 'Xin chào missing', PIPER_VI_VOICE_ID);
    expect(deps.upload).toHaveBeenNthCalledWith(1, 'p1', 'stale', 4, new Uint8Array([0, 0, 1, 0]));
    expect(deps.upload).toHaveBeenNthCalledWith(2, 'p1', 'missing', 5, new Uint8Array([0, 0, 1, 0]));
    expect(events.filter((event) => event.startsWith('synthesize:') || event.startsWith('upload:'))).toEqual([
      `synthesize:Xin chào stale:${PIPER_VI_VOICE_ID}`,
      'upload:p1:stale:4:4',
      `synthesize:Xin chào missing:${PIPER_VI_VOICE_ID}`,
      'upload:p1:missing:5:4',
    ]);
  });

  it('fails closed before synthesis when any Vietnamese translation is absent or incomplete', async () => {
    const incomplete = variant('s2', 2, { translationStatus: 'pending' });
    const missing: TranslationVariantDto = { ...variant('s1', 1), translation: null };
    for (const rows of [[missing], [incomplete]]) {
      const deps = services(rows);
      await expect(prepareVietnameseClientVoiceCache('p1', deps)).rejects.toThrow(/translation/i);
      expect(deps.synthesize).not.toHaveBeenCalled();
      expect(deps.upload).not.toHaveBeenCalled();
    }
  });

  it('propagates exact-version upload conflicts and does not synthesize later segments', async () => {
    const deps = services([variant('s1', 2), variant('s2', 3)]);
    deps.upload = vi.fn(async () => {
      throw new ApiError(409, 'TRANSLATION_VARIANT_CONFLICT', 'Translation changed.');
    });

    await expect(prepareVietnameseClientVoiceCache('p1', deps)).rejects.toMatchObject({
      status: 409,
      code: 'TRANSLATION_VARIANT_CONFLICT',
    });
    expect(deps.synthesize).toHaveBeenCalledTimes(1);
    expect(deps.upload).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the fresh Vietnamese target has no segment variants', async () => {
    const deps = services([]);
    await expect(prepareVietnameseClientVoiceCache('p1', deps)).rejects.toThrow(/translation/i);
    expect(deps.synthesize).not.toHaveBeenCalled();
  });
});
