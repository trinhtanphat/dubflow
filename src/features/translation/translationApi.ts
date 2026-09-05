import { apiFetch } from '../../lib/api/client';
import type { CloudSegment } from '../transcript/segmentApi';

export type TranslationMode = 'workers-ai' | 'google' | 'compare';
export type TranslationChoice = { id: string; text: string; provider: string };

export type PersistedTranslationResult = {
  mode: 'workers-ai' | 'google';
  result: TranslationChoice;
  segment: CloudSegment | null;
};

export type CompareTranslationResult = {
  mode: 'compare';
  workersAI: TranslationChoice[];
  google: TranslationChoice[];
};

export type RetranslateResult = PersistedTranslationResult | CompareTranslationResult;

export function retranslateSegment(projectId: string, segmentId: string, mode: TranslationMode) {
  return apiFetch<RetranslateResult>(`/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/retranslate`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
}
