import type { TranslationVariantDto } from '../translation/languageVariantsApi';
import type { ClientVoiceUploadDto } from './clientVoiceApi';

export type ClientVoiceProgress =
  | { stage: 'loading-model'; loaded?: number; total?: number }
  | { stage: 'synthesizing'; index: number; total: number; segmentId: string }
  | { stage: 'uploading'; index: number; total: number; segmentId: string }
  | { stage: 'verifying'; total: number };

export type ClientVoicePreloadDeps = {
  fetchVariants: (projectId: string) => Promise<TranslationVariantDto[]>;
  synthesize: (
    text: string,
    onProgress?: (loaded?: number, total?: number) => void,
  ) => Promise<Uint8Array>;
  upload: (
    projectId: string,
    segmentId: string,
    version: number,
    pcm: Uint8Array,
  ) => Promise<ClientVoiceUploadDto>;
};

export function targetVietnameseVoiceKey(
  projectId: string,
  segmentId: string,
  version: number,
): string {
  return `projects/${projectId}/voices/vi/${segmentId}/${version}.pcm`;
}

function validTranslation(row: TranslationVariantDto): boolean {
  const translation = row.translation;
  return Boolean(
    translation
    && translation.targetLanguage === 'vi'
    && translation.segmentId === row.segmentId
    && translation.translationStatus === 'completed'
    && translation.translatedText.trim()
    && Number.isSafeInteger(translation.version)
    && translation.version > 0,
  );
}

export function isExactVietnameseVoiceCached(
  projectId: string,
  row: TranslationVariantDto,
): boolean {
  if (!validTranslation(row) || !row.translation) return false;
  return row.translation.voiceStatus === 'completed'
    && row.translation.dubbedObjectKey === targetVietnameseVoiceKey(
      projectId,
      row.segmentId,
      row.translation.version,
    );
}

export function vietnameseClientCacheComplete(
  projectId: string,
  rows: TranslationVariantDto[],
): boolean {
  return rows.length > 0 && rows.every((row) => isExactVietnameseVoiceCached(projectId, row));
}

function requireTranslations(rows: TranslationVariantDto[]) {
  if (rows.length === 0 || rows.some((row) => !validTranslation(row))) {
    throw new Error('Completed non-empty Vietnamese translations are required before client voice preparation.');
  }
}

function requireExactUpload(
  projectId: string,
  row: TranslationVariantDto,
  result: ClientVoiceUploadDto,
) {
  const translation = row.translation!;
  const expectedKey = targetVietnameseVoiceKey(projectId, row.segmentId, translation.version);
  if (
    result.targetLanguage !== 'vi'
    || result.segmentId !== row.segmentId
    || result.version !== translation.version
    || result.voiceStatus !== 'completed'
    || result.objectKey !== expectedKey
  ) {
    throw new Error('Client voice upload did not persist the exact translation-version cache artifact.');
  }
}

export async function preloadVietnameseVoices(
  projectId: string,
  deps: ClientVoicePreloadDeps,
  onProgress?: (progress: ClientVoiceProgress) => void,
): Promise<TranslationVariantDto[]> {
  const initial = await deps.fetchVariants(projectId);
  requireTranslations(initial);
  const pending = initial.filter((row) => !isExactVietnameseVoiceCached(projectId, row));
  if (pending.length === 0) return initial;

  for (let index = 0; index < pending.length; index += 1) {
    const row = pending[index];
    const translation = row.translation!;
    onProgress?.({ stage: 'synthesizing', index: index + 1, total: pending.length, segmentId: row.segmentId });
    const pcm = await deps.synthesize(translation.translatedText, (loaded, total) => {
      onProgress?.({ stage: 'loading-model', loaded, total });
    });
    onProgress?.({ stage: 'uploading', index: index + 1, total: pending.length, segmentId: row.segmentId });
    const result = await deps.upload(projectId, row.segmentId, translation.version, pcm);
    requireExactUpload(projectId, row, result);
  }

  onProgress?.({ stage: 'verifying', total: initial.length });
  const verified = await deps.fetchVariants(projectId);
  requireTranslations(verified);
  if (!vietnameseClientCacheComplete(projectId, verified)) {
    throw new Error('Unable to verify the exact Vietnamese client voice cache after upload.');
  }
  return verified;
}
