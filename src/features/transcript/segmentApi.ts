import { ApiError, apiFetch } from '../../lib/api/client';

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

export class SegmentVersionConflictError extends Error {
  readonly code = 'SEGMENT_VERSION_CONFLICT';

  constructor(public readonly canonical: CloudSegment) {
    super('Segment changed on the server.');
    this.name = 'SegmentVersionConflictError';
  }
}

function isCloudSegment(value: unknown): value is CloudSegment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const segment = value as Record<string, unknown>;
  return typeof segment.id === 'string'
    && typeof segment.projectId === 'string'
    && (segment.speakerId === null || typeof segment.speakerId === 'string')
    && typeof segment.startMs === 'number'
    && typeof segment.endMs === 'number'
    && typeof segment.sourceText === 'string'
    && typeof segment.translatedText === 'string'
    && typeof segment.translationEngine === 'string'
    && typeof segment.translationStatus === 'string'
    && typeof segment.voiceStatus === 'string'
    && Number.isInteger(segment.version)
    && (segment.version as number) > 0;
}

export function segmentVersionConflictFrom(error: unknown): SegmentVersionConflictError | null {
  if (error instanceof ApiError
    && error.status === 409
    && error.code === 'SEGMENT_VERSION_CONFLICT'
    && error.payload
    && typeof error.payload === 'object'
    && !Array.isArray(error.payload)) {
    const canonical = (error.payload as Record<string, unknown>).segment;
    if (isCloudSegment(canonical)) return new SegmentVersionConflictError(canonical);
  }
  return null;
}

async function withSegmentConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const conflict = segmentVersionConflictFrom(error);
    if (conflict) throw conflict;
    throw error;
  }
}

export function listSegments(projectId: string) {
  return apiFetch<CloudSegment[]>(`/api/projects/${encodeURIComponent(projectId)}/segments`);
}

export function patchSegment(projectId: string, segmentId: string, expectedVersion: number, patch: SegmentPatch) {
  return withSegmentConflict(() => apiFetch<CloudSegment>(
    `/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ expectedVersion, patch }),
    },
  ));
}

export function splitSegment(projectId: string, segmentId: string, expectedVersion: number, playheadMs: number) {
  return withSegmentConflict(() => apiFetch<{ left: CloudSegment; right: CloudSegment }>(
    `/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/split`,
    {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, playheadMs }),
    },
  ));
}

export function restoreSplit(
  projectId: string,
  segmentId: string,
  expectedVersion: number,
  childSegmentId: string,
  expectedChildVersion: number,
  original: RestoreSegmentInput,
) {
  return withSegmentConflict(() => apiFetch<CloudSegment>(
    `/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/restore-split`,
    {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, childSegmentId, expectedChildVersion, original }),
    },
  ));
}
