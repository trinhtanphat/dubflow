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
  splitParentId?: string | null;
};

export type SegmentPatch = Partial<Pick<CloudSegment, 'sourceText' | 'translatedText' | 'speakerId' | 'startMs' | 'endMs'>>;
export type RestoreSegmentInput = Pick<CloudSegment, 'startMs' | 'endMs' | 'sourceText' | 'translatedText' | 'speakerId'>;

export function listSegments(projectId: string) {
  return apiFetch<CloudSegment[]>(`/api/projects/${encodeURIComponent(projectId)}/segments`);
}

export function patchSegment(projectId: string, segmentId: string, patch: SegmentPatch) {
  return apiFetch<CloudSegment>(`/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function splitSegment(projectId: string, segmentId: string, playheadMs: number) {
  return apiFetch<{ left: CloudSegment; right: CloudSegment }>(
    `/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/split`,
    {
      method: 'POST',
      body: JSON.stringify({ playheadMs }),
    },
  );
}

export function restoreSplit(
  projectId: string,
  segmentId: string,
  childSegmentId: string,
  original: RestoreSegmentInput,
) {
  return apiFetch<CloudSegment>(
    `/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/restore-split`,
    {
      method: 'POST',
      body: JSON.stringify({ childSegmentId, original }),
    },
  );
}
