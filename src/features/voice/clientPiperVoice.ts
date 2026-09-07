import {
  getTranslationVariants,
  type TranslationVariantDto,
} from '../translation/languageVariantsApi';
import { wavToClientPcm } from './clientPcm';
import { uploadClientVoicePcm, type ClientVoiceUploadResult } from './voiceApi';

export const PIPER_VI_VOICE_ID = 'vi_VN-vais1000-medium';

export type ClientPiperVoiceServices = {
  getVariants: (projectId: string) => Promise<TranslationVariantDto[]>;
  synthesize: (text: string, voiceId: string) => Promise<Blob>;
  convert: (wav: ArrayBuffer) => Uint8Array;
  upload: (
    projectId: string,
    segmentId: string,
    translationVersion: number,
    pcm: Uint8Array,
  ) => Promise<ClientVoiceUploadResult>;
};

function expectedVoiceObjectKey(projectId: string, segmentId: string, version: number): string {
  return `projects/${projectId}/voices/vi/${segmentId}/${version}.pcm`;
}

async function getFreshVietnameseVariants(projectId: string): Promise<TranslationVariantDto[]> {
  return getTranslationVariants(projectId, 'vi');
}

async function synthesizeWithPiper(text: string, voiceId: string): Promise<Blob> {
  const tts = await import('@mintplex-labs/piper-tts-web');
  return tts.predict({ text, voiceId });
}

function defaultServices(): ClientPiperVoiceServices {
  return {
    getVariants: getFreshVietnameseVariants,
    synthesize: synthesizeWithPiper,
    convert: wavToClientPcm,
    upload: uploadClientVoicePcm,
  };
}

export function isLocalPiperSupported(): boolean {
  if (typeof window === 'undefined' || typeof WebAssembly === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<unknown> };
  return typeof storage?.getDirectory === 'function';
}

export async function prepareVietnameseClientVoiceCache(
  projectId: string,
  services: ClientPiperVoiceServices = defaultServices(),
): Promise<{ synthesized: number; reused: number }> {
  const variants = await services.getVariants(projectId);
  if (variants.length === 0) {
    throw new Error('Vietnamese translation variants are not available for local voice synthesis.');
  }

  for (const row of variants) {
    const translation = row.translation;
    if (
      !translation
      || translation.targetLanguage !== 'vi'
      || translation.translationStatus !== 'completed'
      || !translation.translatedText.trim()
      || !Number.isSafeInteger(translation.version)
      || translation.version <= 0
    ) {
      throw new Error('Every Vietnamese segment requires a completed current translation before local voice synthesis.');
    }
  }

  let synthesized = 0;
  let reused = 0;
  for (const row of variants) {
    const translation = row.translation!;
    const expectedKey = expectedVoiceObjectKey(projectId, row.segmentId, translation.version);
    if (translation.voiceStatus === 'completed' && translation.dubbedObjectKey === expectedKey) {
      reused += 1;
      continue;
    }

    const wav = await services.synthesize(translation.translatedText.trim(), PIPER_VI_VOICE_ID);
    const pcm = services.convert(await wav.arrayBuffer());
    await services.upload(projectId, row.segmentId, translation.version, pcm);
    synthesized += 1;
  }

  return { synthesized, reused };
}
