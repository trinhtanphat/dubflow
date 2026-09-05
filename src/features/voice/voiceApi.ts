import { ApiError, apiFetch } from '../../lib/api/client';

export type VoiceCapabilities = {
  provider?: string;
  configured?: boolean;
  languages: string[] | 'unknown';
  cloning: boolean;
  preview?: boolean;
};

export type VoicePreviewInput = {
  text: string;
  language: 'vi';
  voice?: string;
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
