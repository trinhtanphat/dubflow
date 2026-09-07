import { apiFetch } from '../../lib/api/client';
import { CLIENT_PCM_MAX_BYTES, CLIENT_PCM_SAMPLE_RATE } from './clientPcm';

export type ClientVoiceUploadDto = {
  targetLanguage: 'vi';
  segmentId: string;
  version: number;
  voiceStatus: string;
  objectKey: string | null;
};

export async function uploadVietnameseVoicePcm(
  projectId: string,
  segmentId: string,
  version: number,
  pcm: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientVoiceUploadDto> {
  if (!Number.isInteger(version) || version < 1) throw new Error('Translation version must be a positive integer.');
  if (pcm.byteLength === 0) throw new Error('Client PCM body is empty.');
  if (pcm.byteLength % 2 !== 0) throw new Error('Client PCM body must have an even byte length.');
  if (pcm.byteLength > CLIENT_PCM_MAX_BYTES) throw new Error('Client PCM exceeds the 8 MiB limit.');

  const body = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  const path = `/api/projects/${encodeURIComponent(projectId)}/translations/vi/${encodeURIComponent(segmentId)}/voice-pcm`;
  return apiFetch<ClientVoiceUploadDto>(path, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'X-DubFlow-PCM-Format': 's16le',
      'X-DubFlow-PCM-Sample-Rate': String(CLIENT_PCM_SAMPLE_RATE),
      'X-DubFlow-PCM-Channels': '1',
      'X-DubFlow-Translation-Version': String(version),
    },
    body,
  }, fetchImpl);
}
