import { ApiError, apiFetch } from '../../lib/api/client';

export type VoiceCapabilities = {
  provider?: string;
  configured?: boolean;
  languages: string[] | 'unknown';
  cloning: boolean;
  preview?: boolean;
  cloneEnrollment: {
    provider: 'elevenlabs';
    mode: 'ivc';
    available: boolean;
  };
};

export type VoicePreviewInput = {
  text: string;
  language: 'vi';
  voice?: string;
};

export type ClientVoiceUploadResult = {
  targetLanguage: 'vi';
  segmentId: string;
  version: number;
  voiceStatus: string;
  objectKey: string | null;
};

export function fetchVoiceCapabilities(fetchImpl: typeof fetch = fetch): Promise<VoiceCapabilities> {
  return apiFetch<VoiceCapabilities>('/api/voice/capabilities', { method: 'GET' }, fetchImpl);
}

export async function fetchVoicePreview(input: VoicePreviewInput, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  const response = await fetchImpl('/api/voice/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json() as Record<string, unknown>
      : {};
    throw new ApiError(
      response.status,
      typeof payload.code === 'string' ? payload.code : 'VOICE_PREVIEW_FAILED',
      typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`,
    );
  }
  return response.blob();
}

export function uploadClientVoicePcm(
  projectId: string,
  segmentId: string,
  translationVersion: number,
  pcm: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientVoiceUploadResult> {
  const body = Uint8Array.from(pcm).buffer;
  return apiFetch<ClientVoiceUploadResult>(
    `/api/projects/${encodeURIComponent(projectId)}/translations/vi/${encodeURIComponent(segmentId)}/voice-pcm`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'X-DubFlow-PCM-Format': 's16le',
        'X-DubFlow-PCM-Sample-Rate': '24000',
        'X-DubFlow-PCM-Channels': '1',
        'X-DubFlow-Translation-Version': String(translationVersion),
      },
      body,
    },
    fetchImpl,
  );
}
