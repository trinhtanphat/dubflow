import { apiFetch } from '../../lib/api/client';

export type VoiceCloneStatus =
  | 'creating'
  | 'verification_required'
  | 'ready'
  | 'failed'
  | 'deleting'
  | 'deleted';

export type VoiceClone = {
  id: string;
  userId: string;
  projectId: string;
  provider: 'elevenlabs';
  providerVoiceId: string | null;
  name: string;
  status: VoiceCloneStatus;
  consentVersion: string;
  consentedAt: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export const VOICE_CLONE_CONSENT_VERSION = 'voice-clone-consent-v1';

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/voice-clones`;
}

export function listVoiceClones(projectId: string, fetchImpl: typeof fetch = fetch): Promise<VoiceClone[]> {
  return apiFetch<VoiceClone[]>(base(projectId), { method: 'GET' }, fetchImpl);
}

export function createVoiceClone(projectId: string, name: string, fetchImpl: typeof fetch = fetch): Promise<VoiceClone> {
  return apiFetch<VoiceClone>(base(projectId), {
    method: 'POST',
    body: JSON.stringify({
      name,
      consentVersion: VOICE_CLONE_CONSENT_VERSION,
      consentAcknowledged: true,
    }),
  }, fetchImpl);
}

export function uploadVoiceCloneSample(projectId: string, cloneId: string, sample: File | Blob, fetchImpl: typeof fetch = fetch): Promise<{ cloneId: string; uploaded: boolean; size: number }> {
  return apiFetch(`${base(projectId)}/${encodeURIComponent(cloneId)}/sample`, {
    method: 'POST',
    headers: { 'content-type': sample.type || 'application/octet-stream' },
    body: sample,
  }, fetchImpl);
}

export function enrollManagedVoiceClone(projectId: string, cloneId: string, fetchImpl: typeof fetch = fetch): Promise<VoiceClone> {
  return apiFetch<VoiceClone>(`${base(projectId)}/${encodeURIComponent(cloneId)}/enroll`, { method: 'POST' }, fetchImpl);
}

export function assignManagedVoiceClone(projectId: string, speakerId: string, cloneId: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  return apiFetch(`/api/projects/${encodeURIComponent(projectId)}/speakers/${encodeURIComponent(speakerId)}/voice-clone/${encodeURIComponent(cloneId)}`, { method: 'POST' }, fetchImpl);
}

export function deleteManagedVoiceClone(projectId: string, cloneId: string, fetchImpl: typeof fetch = fetch): Promise<VoiceClone> {
  return apiFetch<VoiceClone>(`${base(projectId)}/${encodeURIComponent(cloneId)}`, { method: 'DELETE' }, fetchImpl);
}
