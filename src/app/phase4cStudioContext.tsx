import { createContext, useContext } from 'react';
import type { DubbedAudioMode, ExportCapabilitiesDto } from '../features/export/batchExportApi';
import type { Segment } from '../features/timeline/types';
import type {
  TargetLanguage,
  TranslationVariantDto,
} from '../features/translation/languageVariantsApi';
import type { StudioLanguage } from '../features/translation/TargetLanguagesPanel';

export type Phase4CStudioContextValue = {
  currentLanguage: StudioLanguage;
  targetLanguage: TargetLanguage | null;
  targetSegments: TranslationVariantDto[];
  targetDrafts: Record<string, string>;
  targetConflict: string;
  audioMode: DubbedAudioMode;
  exportCapabilities: ExportCapabilitiesDto | null;
  setAudioMode: (audioMode: DubbedAudioMode) => void;
  editTargetTranslation: (segmentId: string, text: string) => void;
  flushTargetTranslation: (segmentId: string) => Promise<void>;
};

const Phase4CStudioContext = createContext<Phase4CStudioContextValue | null>(null);

export function Phase4CStudioProvider({ value, children }: { value: Phase4CStudioContextValue; children: React.ReactNode }) {
  return <Phase4CStudioContext.Provider value={value}>{children}</Phase4CStudioContext.Provider>;
}

export function usePhase4CStudio() {
  return useContext(Phase4CStudioContext);
}

export function composeTargetSegment(
  canonical: Segment,
  variant?: TranslationVariantDto | null,
  draftText?: string,
): Segment {
  return {
    ...canonical,
    translatedText: draftText ?? variant?.translation?.translatedText ?? '',
  };
}
