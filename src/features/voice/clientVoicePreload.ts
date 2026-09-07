import { ApiError } from '../../lib/api/client';
import {
  getTranslationVariants,
  type TranslationVariantDto,
} from '../translation/languageVariantsApi';
import type { BrowserPiperRuntime } from './browserPiper';
import {
  canonicalClientVoiceObjectKey,
  uploadClientVoicePcm,
  type ClientVoiceUploadResult,
} from './clientVoiceApi';

export type ClientVoicePreloadState =
  | { phase: 'idle' }
  | { phase: 'loading_model'; percent: number | null }
  | { phase: 'synthesizing'; completed: number; total: number; segmentId: string }
  | { phase: 'uploading'; completed: number; total: number; segmentId: string }
  | { phase: 'verifying'; completed: number; total: number }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; total: number };

type PreloadDeps = {
  getVariants: typeof getTranslationVariants;
  upload: (input: {
    projectId: string;
    segmentId: string;
    version: number;
    pcm: Uint8Array;
  }) => Promise<ClientVoiceUploadResult>;
};

const defaultDeps: PreloadDeps = {
  getVariants: getTranslationVariants,
  upload: uploadClientVoicePcm,
};

function abortIfRequested(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function completedTranslation(row: TranslationVariantDto) {
  const translation = row.translation;
  return Boolean(
    translation
      && translation.translationStatus === 'completed'
      && translation.translatedText.trim(),
  );
}

export function hasExactVietnameseClientVoice(projectId: string, row: TranslationVariantDto): boolean {
  const translation = row.translation;
  if (!translation || !completedTranslation(row)) return false;
  return translation.voiceStatus === 'completed'
    && translation.dubbedObjectKey === canonicalClientVoiceObjectKey(
      projectId,
      row.segmentId,
      translation.version,
    );
}

function requireReadyTranslation(row: TranslationVariantDto) {
  const translation = row.translation;
  if (!translation || !completedTranslation(row)) {
    throw new Error(`Bản dịch tiếng Việt cho segment ${row.segmentId} chưa hoàn tất.`);
  }
  return translation;
}

function isVariantConflict(error: unknown) {
  return error instanceof ApiError
    && error.status === 409
    && error.code === 'TRANSLATION_VARIANT_CONFLICT';
}

export async function ensureVietnameseClientVoiceCache(
  input: {
    projectId: string;
    runtime: BrowserPiperRuntime;
    decodeWav: (wav: Blob) => Promise<Uint8Array>;
    signal?: AbortSignal;
    onState?: (state: ClientVoicePreloadState) => void;
  },
  deps: PreloadDeps = defaultDeps,
): Promise<void> {
  const emit = input.onState ?? (() => {});
  const fail = (error: unknown): never => {
    const message = error instanceof Error && error.message ? error.message : 'Không thể chuẩn bị giọng Việt cục bộ.';
    emit({ phase: 'failed', message });
    throw error instanceof Error ? error : new Error(message);
  };

  try {
    abortIfRequested(input.signal);
    let variants = await deps.getVariants(input.projectId, 'vi');
    if (variants.length === 0) throw new Error('Chưa có segment tiếng Việt để chuẩn bị giọng.');
    for (const row of variants) requireReadyTranslation(row);

    const misses = variants.filter((row) => !hasExactVietnameseClientVoice(input.projectId, row));
    if (misses.length === 0) {
      emit({ phase: 'ready', total: variants.length });
      return;
    }

    emit({ phase: 'loading_model', percent: null });
    await input.runtime.ensureModel((progress) => emit({ phase: 'loading_model', percent: progress.percent }));

    let completed = variants.length - misses.length;
    const total = variants.length;

    const synthesizeAndUpload = async (row: TranslationVariantDto, allowConflictRetry: boolean): Promise<void> => {
      abortIfRequested(input.signal);
      const translation = requireReadyTranslation(row);
      emit({ phase: 'synthesizing', completed, total, segmentId: row.segmentId });
      const wav = await input.runtime.synthesize(translation.translatedText);
      abortIfRequested(input.signal);
      const pcm = await input.decodeWav(wav);
      emit({ phase: 'uploading', completed, total, segmentId: row.segmentId });
      try {
        await deps.upload({
          projectId: input.projectId,
          segmentId: row.segmentId,
          version: translation.version,
          pcm,
        });
        completed += 1;
      } catch (error) {
        if (!allowConflictRetry || !isVariantConflict(error)) throw error;
        abortIfRequested(input.signal);
        variants = await deps.getVariants(input.projectId, 'vi');
        const canonical = variants.find((candidate) => candidate.segmentId === row.segmentId);
        if (!canonical) throw new Error(`Segment ${row.segmentId} không còn tồn tại sau xung đột version.`);
        await synthesizeAndUpload(canonical, false);
      }
    };

    for (const row of misses) {
      await synthesizeAndUpload(row, true);
    }

    abortIfRequested(input.signal);
    emit({ phase: 'verifying', completed, total });
    const verified = await deps.getVariants(input.projectId, 'vi');
    if (verified.length !== total || !verified.every((row) => hasExactVietnameseClientVoice(input.projectId, row))) {
      throw new Error('Voice cache tiếng Việt chưa hoàn tất sau khi upload.');
    }
    emit({ phase: 'ready', total });
  } catch (error) {
    fail(error);
  }
}
