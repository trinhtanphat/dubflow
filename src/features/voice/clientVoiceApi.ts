import { apiFetch } from '../../lib/api/client';

export type ClientVoiceUploadResult = {
  targetLanguage: 'vi';
  segmentId: string;
  version: number;
  voiceStatus: 'completed';
  objectKey: string;
};

export function canonicalClientVoiceObjectKey(
  projectId: string,
  segmentId: string,
  version: number,
): string {
  return `projects/${projectId}/voices/vi/${segmentId}/${version}.pcm`;
}

export async function uploadClientVoicePcm(
  input: {
    projectId: string;
    segmentId: string;
    version: number;
    pcm: Uint8Array;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ClientVoiceUploadResult> {
  const body = input.pcm.buffer.slice(
    input.pcm.byteOffset,
    input.pcm.byteOffset + input.pcm.byteLength,
  ) as ArrayBuffer;
  return apiFetch<ClientVoiceUploadResult>(
    `/api/projects/${encodeURIComponent(input.projectId)}/translations/vi/${encodeURIComponent(input.segmentId)}/voice-pcm`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'X-DubFlow-PCM-Format': 's16le',
        'X-DubFlow-PCM-Sample-Rate': '24000',
        'X-DubFlow-PCM-Channels': '1',
        'X-DubFlow-Translation-Version': String(input.version),
      },
      body,
    },
    fetchImpl,
  );
}
