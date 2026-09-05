import { apiFetch } from '../../lib/api/client';

export type BeginMultipart = { uploadId: string; objectKey: string; partSizeBytes: number };
export type UploadedPart = { partNumber: number; etag: string };
export type CompletedUpload = { objectKey: string; size: number };

export async function uploadMediaMultipart(
  projectId: string,
  file: File,
  fetchImpl: typeof fetch = fetch,
  onProgress: (ratio: number) => void = () => {},
): Promise<CompletedUpload> {
  const beginResponse = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: file.name, sizeBytes: file.size, contentType: file.type }),
  });
  if (!beginResponse.ok) {
    const body = await beginResponse.json().catch(() => ({})) as any;
    throw new Error(body.message ?? `Upload initialization failed (${beginResponse.status}).`);
  }
  const begin = await beginResponse.json() as BeginMultipart;
  const parts: UploadedPart[] = [];
  const count = Math.ceil(file.size / begin.partSizeBytes);
  for (let index = 0; index < count; index += 1) {
    const partNumber = index + 1;
    const start = index * begin.partSizeBytes;
    const end = Math.min(file.size, start + begin.partSizeBytes);
    const body = file.slice(start, end);
    const response = await fetchImpl(
      `/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(begin.uploadId)}/parts/${partNumber}?objectKey=${encodeURIComponent(begin.objectKey)}`,
      { method: 'PUT', body },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as any;
      throw new Error(failure.message ?? `Upload part ${partNumber} failed (${response.status}).`);
    }
    parts.push(await response.json() as UploadedPart);
    onProgress(Math.min(0.98, end / file.size));
  }
  const result = await apiFetch<CompletedUpload>(
    `/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(begin.uploadId)}/complete`,
    { method: 'POST', body: JSON.stringify({ objectKey: begin.objectKey, parts }) },
    fetchImpl,
  );
  onProgress(1);
  return result;
}
