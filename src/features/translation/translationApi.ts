import { apiFetch } from '../../lib/api/client';

export type TranslationMode = 'workers-ai' | 'google' | 'compare';

export function retranslateSegment(projectId: string, segmentId: string, mode: TranslationMode) {
  return apiFetch(`/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/retranslate`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
}
