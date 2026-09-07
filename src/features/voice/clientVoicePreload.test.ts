import { describe, expect, it, vi } from 'vitest';
import type { TranslationVariantDto } from '../translation/languageVariantsApi';
import {
  isExactVietnameseVoiceCached,
  preloadVietnameseVoices,
  targetVietnameseVoiceKey,
} from './clientVoicePreload';

function row({
  id,
  version = 1,
  voiceStatus = 'pending',
  objectKey = null,
  text = `Bản dịch ${id}`,
  translationStatus = 'completed',
}: {
  id: string;
  version?: number;
  voiceStatus?: string;
  objectKey?: string | null;
  text?: string;
  translationStatus?: string;
}): TranslationVariantDto {
  return {
    segmentId: id,
    speakerId: null,
    startMs: 0,
    endMs: 1000,
    sourceText: `Source ${id}`,
    sourceVersion: 1,
    translation: {
      segmentId: id,
      projectId: 'p1',
      targetLanguage: 'vi',
      translatedText: text,
      translationEngine: 'test',
      translationStatus,
      translationContextRevision: 1,
      voiceStatus,
      dubbedObjectKey: objectKey,
      version,
    },
  };
}

function exactRow(id: string, version = 1) {
  return row({
    id,
    version,
    voiceStatus: 'completed',
    objectKey: targetVietnameseVoiceKey('p1', id, version),
  });
}

describe('Vietnamese client voice cache identity', () => {
  it('requires the completed exact-version canonical object key', () => {
    expect(targetVietnameseVoiceKey('p1', 's1', 3)).toBe('projects/p1/voices/vi/s1/3.pcm');
    expect(isExactVietnameseVoiceCached('p1', exactRow('s1', 3))).toBe(true);
    expect(isExactVietnameseVoiceCached('p1', row({
      id: 's1', version: 3, voiceStatus: 'completed', objectKey: 'projects/p1/voices/vi/s1/2.pcm',
    }))).toBe(false);
  });
});

describe('preloadVietnameseVoices', () => {
  it('skips Piper and upload when every translation is already exact-cache complete', async () => {
    const rows = [exactRow('s1'), exactRow('s2', 2)];
    const fetchVariants = vi.fn(async () => rows);
    const synthesize = vi.fn();
    const upload = vi.fn();

    await expect(preloadVietnameseVoices('p1', { fetchVariants, synthesize, upload })).resolves.toEqual(rows);
    expect(fetchVariants).toHaveBeenCalledTimes(1);
    expect(synthesize).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('synthesizes only missing or stale rows sequentially with their exact versions', async () => {
    const initial = [
      exactRow('cached', 1),
      row({ id: 'missing', version: 2 }),
      row({ id: 'stale', version: 4, voiceStatus: 'completed', objectKey: targetVietnameseVoiceKey('p1', 'stale', 3) }),
    ];
    const verified = [exactRow('cached', 1), exactRow('missing', 2), exactRow('stale', 4)];
    const fetchVariants = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(verified);
    const events: string[] = [];
    const synthesize = vi.fn(async (text: string) => {
      events.push(`synth:${text}`);
      return new Uint8Array([0, 0]);
    });
    const upload = vi.fn(async (_projectId: string, segmentId: string, version: number) => {
      events.push(`upload:${segmentId}:${version}`);
      return {
        targetLanguage: 'vi' as const,
        segmentId,
        version,
        voiceStatus: 'completed',
        objectKey: targetVietnameseVoiceKey('p1', segmentId, version),
      };
    });

    await expect(preloadVietnameseVoices('p1', { fetchVariants, synthesize, upload })).resolves.toEqual(verified);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((call) => [call[1], call[2]])).toEqual([['missing', 2], ['stale', 4]]);
    expect(events).toEqual([
      'synth:Bản dịch missing',
      'upload:missing:2',
      'synth:Bản dịch stale',
      'upload:stale:4',
    ]);
    expect(fetchVariants).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on partial failure and never processes later rows', async () => {
    const fetchVariants = vi.fn(async () => [row({ id: 's1' }), row({ id: 's2' })]);
    const synthesize = vi.fn()
      .mockResolvedValueOnce(new Uint8Array([0, 0]))
      .mockRejectedValueOnce(new Error('Piper failed'));
    const upload = vi.fn(async (_projectId: string, segmentId: string, version: number) => ({
      targetLanguage: 'vi' as const,
      segmentId,
      version,
      voiceStatus: 'completed',
      objectKey: targetVietnameseVoiceKey('p1', segmentId, version),
    }));

    await expect(preloadVietnameseVoices('p1', { fetchVariants, synthesize, upload })).rejects.toThrow(/Piper failed/);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(fetchVariants).toHaveBeenCalledTimes(1);
  });

  it('fails closed when upload response or post-upload canonical state is not exact', async () => {
    const missing = [row({ id: 's1', version: 2 })];
    const fetchVariants = vi.fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(missing);
    const synthesize = vi.fn(async () => new Uint8Array([0, 0]));
    const upload = vi.fn(async () => ({
      targetLanguage: 'vi' as const,
      segmentId: 's1',
      version: 2,
      voiceStatus: 'completed',
      objectKey: targetVietnameseVoiceKey('p1', 's1', 2),
    }));

    await expect(preloadVietnameseVoices('p1', { fetchVariants, synthesize, upload })).rejects.toThrow(/verify|exact|cache/i);
    expect(fetchVariants).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete or invalid translations before synthesis', async () => {
    const synthesize = vi.fn();
    const upload = vi.fn();
    await expect(preloadVietnameseVoices('p1', {
      fetchVariants: async () => [row({ id: 's1', text: '   ' })],
      synthesize,
      upload,
    })).rejects.toThrow(/translation/i);
    expect(synthesize).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
