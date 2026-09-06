import { apiFetch } from '../../lib/api/client';
import { segmentVersionConflictFrom, type CloudSegment } from '../transcript/segmentApi';

export type TranslationMode = 'workers-ai' | 'google' | 'compare' | 'contextual';
export type TranslationChoice = { id: string; text: string; provider: string };

export type PersistedTranslationResult = {
  mode: 'workers-ai' | 'google' | 'contextual';
  result: TranslationChoice;
  segment: CloudSegment | null;
  contextRevision: number | null;
};

export type CompareTranslationResult = {
  mode: 'compare';
  workersAI: TranslationChoice[];
  google: TranslationChoice[];
};

export type RetranslateResult = PersistedTranslationResult | CompareTranslationResult;

type PersistedTranslationResponse = Omit<PersistedTranslationResult, 'contextRevision'> & {
  contextRevision?: number | null;
};
type RetranslateResponse = PersistedTranslationResponse | CompareTranslationResult;

function contextRevisionFromSegment(segment: CloudSegment | null): number | null {
  if (!segment) return null;
  const value = (segment as unknown as Record<string, unknown>).translationContextRevision;
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null;
}

export async function retranslateSegment(
  projectId: string,
  segmentId: string,
  expectedVersion: number,
  mode?: TranslationMode,
): Promise<RetranslateResult> {
  try {
    const body = mode === undefined
      ? { expectedVersion }
      : { expectedVersion, mode };
    const response = await apiFetch<RetranslateResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/retranslate`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    if (response.mode === 'compare') return response;
    return {
      ...response,
      contextRevision: response.contextRevision ?? contextRevisionFromSegment(response.segment),
    };
  } catch (error) {
    const conflict = segmentVersionConflictFrom(error);
    if (conflict) throw conflict;
    throw error;
  }
}
