import { apiFetch } from '../../lib/api/client';

export type CloudSegment = {
  id: string;
  projectId: string;
  speakerId: string | null;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
  translationEngine: string;
  translationStatus: string;
  voiceStatus: string;
  version: number;
};

export type SegmentPatch = Partial<Pick<CloudSegment, 'sourceText' | 'translatedText' | 'speakerId' | 'startMs' | 'endMs'>>;

export function listSegments(projectId: string) {
  return apiFetch<CloudSegment[]>(`/api/projects/${encodeURIComponent(projectId)}/segments`);
}

export function patchSegment(projectId: string, segmentId: string, patch: SegmentPatch) {
  return apiFetch<CloudSegment>(`/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}
