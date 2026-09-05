import { apiFetch } from '../../lib/api/client';

export type CloudSpeaker = {
  id: string;
  projectId: string;
  label: string;
  displayName: string;
  voiceProvider: string | null;
  voiceId: string | null;
  avatarObjectKey: string | null;
};

export type CloudSpeakerPatch = {
  displayName?: string;
  voiceId?: string | null;
};

export function listSpeakers(projectId: string, fetchImpl: typeof fetch = fetch): Promise<CloudSpeaker[]> {
  return apiFetch<CloudSpeaker[]>(`/api/projects/${encodeURIComponent(projectId)}/speakers`, { method: 'GET' }, fetchImpl);
}

export function updateSpeaker(
  projectId: string,
  speakerId: string,
  patch: CloudSpeakerPatch,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudSpeaker> {
  return apiFetch<CloudSpeaker>(
    `/api/projects/${encodeURIComponent(projectId)}/speakers/${encodeURIComponent(speakerId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
    fetchImpl,
  );
}
