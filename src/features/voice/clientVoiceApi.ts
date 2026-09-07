import { apiFetch } from '../../lib/api/client';
import { CLIENT_PCM_MAX_BYTES } from './clientPcm';

export type ClientVoiceUploadDto = {
  targetLanguage: 'vi';
  segmentId: string;
  version: number;
  voiceStatus: string;
  objectKey: string | null;
};

export function uploadVietnameseVoicePcm(
  projectId: string,
  segmentId: string,
  version: number,
  pcm: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientVoiceUploadDto> {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Client voice translation version must be a positive integer.');
  if (pcm.byteLength === 0) throw new Error('Client PCM cannot be empty.');
  if (pcm.byteLength % 2 !== 0) throw new Error('Client PCM must contain an even number of bytes.');
  if (pcm.byteLength > CLIENT_PCM_MAX_BYTES) throw new Error('Client PCM exceeds the 8 MiB limit.');

  const path = `/api/projects/${encodeURIComponent(projectId)}`
    + `/translations/vi/${encodeURIComponent(segmentId)}/voice-pcm`;
  const body = Uint8Array.from(pcm).buffer;

  return apiFetch<ClientVoiceUploadDto>(path, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'X-DubFlow-PCM-Format': 's16le',
      'X-DubFlow-PCM-Sample-Rate': '24000',
      'X-DubFlow-PCM-Channels': '1',
      'X-DubFlow-Translation-Version': String(version),
    },
    body,
  }, fetchImpl);
}
