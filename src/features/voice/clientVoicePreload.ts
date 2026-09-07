import type { TranslationVariantDto } from '../translation/languageVariantsApi';
import type { ClientVoiceUploadDto } from './clientVoiceApi';

export type ClientVoiceProgress =
  | { stage: 'loading-model'; loaded?: number; total?: number }
  | { stage: 'synthesizing'; index: number; total: number; segmentId: string }
  | { stage: 'uploading'; index: number; total: number; segmentId: string }
  | { stage: 'verifying'; total: number };

export type ClientVoicePreloadDeps = {
  fetchVariants: (projectId: string) => Promise<TranslationVariantDto[]>;
  synthesize: (text: string, onProgress?: (loaded?: number, total?: number) => void) => Promise<Uint8Array>;
  upload: (projectId: string, segmentId: string, version: number, pcm: Uint8Array) => Promise<ClientVoiceUploadDto>;
};

export function targetVietnameseVoiceKey(projectId: string, segmentId: string, version: number): string {
  return `projects/${projectId}/voices/vi/${segmentId}/${version}.pcm`;
}

function translationForVoice(row: TranslationVariantDto) {
  const translation = row.translation;
  if (!translation
    || translation.targetLanguage !== 'vi'
    || translation.translationStatus !== 'completed'
    || !translation.translatedText.trim()
    || !Number.isInteger(translation.version)
    || translation.version < 1) {
    throw new Error(`Vietnamese translation for segment ${row.segmentId} is incomplete or invalid.`);
  }
  return translation;
}

export function isExactVietnameseVoiceCached(projectId: string, row: TranslationVariantDto): boolean {
  const translation = row.translation;
  if (!translation
    || translation.targetLanguage !== 'vi'
    || translation.translationStatus !== 'completed'
    || !translation.translatedText.trim()
    || !Number.isInteger(translation.version)
    || translation.version < 1) return false;
  return translation.voiceStatus === 'completed'
    && translation.dubbedObjectKey === targetVietnameseVoiceKey(projectId, row.segmentId, translation.version);
}

function assertUploadMatches(projectId: string, row: TranslationVariantDto, response: ClientVoiceUploadDto) {
  const translation = translationForVoice(row);
  const expectedKey = targetVietnameseVoiceKey(projectId, row.segmentId, translation.version);
  if (response.targetLanguage !== 'vi'
    || response.segmentId !== row.segmentId
    || response.version !== translation.version
    || response.voiceStatus !== 'completed'
    || response.objectKey !== expectedKey) {
    throw new Error(`Client voice upload did not verify the exact cache identity for segment ${row.segmentId}.`);
  }
}

export async function preloadVietnameseVoices(
  projectId: string,
  deps: ClientVoicePreloadDeps,
  onProgress?: (progress: ClientVoiceProgress) => void,
): Promise<TranslationVariantDto[]> {
  const initial = await deps.fetchVariants(projectId);
  if (initial.length === 0) throw new Error('Vietnamese translation variants are empty.');
  for (const row of initial) translationForVoice(row);

  const missing = initial.filter((row) => !isExactVietnameseVoiceCached(projectId, row));
  if (missing.length === 0) return initial;

  const total = missing.length;
  for (let offset = 0; offset < missing.length; offset += 1) {
    const row = missing[offset];
    const translation = translationForVoice(row);
    const index = offset + 1;
    onProgress?.({ stage: 'synthesizing', index, total, segmentId: row.segmentId });
    const pcm = await deps.synthesize(translation.translatedText, (loaded, progressTotal) => {
      onProgress?.({ stage: 'loading-model', loaded, total: progressTotal });
    });
    onProgress?.({ stage: 'uploading', index, total, segmentId: row.segmentId });
    const response = await deps.upload(projectId, row.segmentId, translation.version, pcm);
    assertUploadMatches(projectId, row, response);
  }

  onProgress?.({ stage: 'verifying', total });
  const verified = await deps.fetchVariants(projectId);
  if (verified.length === 0 || verified.some((row) => !isExactVietnameseVoiceCached(projectId, row))) {
    throw new Error('Unable to verify the exact Vietnamese client voice cache after preload.');
  }
  return verified;
}
