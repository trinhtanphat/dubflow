import { ApiError, apiFetch } from '../../lib/api/client';

export type CloudProjectStatus = 'draft' | 'uploading' | 'ready' | 'processing' | 'needs_review' | 'failed' | 'completed' | 'cancelled';

export type CloudProject = {
  id: string;
  userId: string;
  title: string;
  sourceLanguage: 'auto' | 'zh' | 'en' | 'ja' | 'ko';
  targetLanguage: 'vi';
  status: CloudProjectStatus;
  sourceGeneration?: number;
  sourceObjectKey?: string | null;
  exportObjectKey?: string | null;
  durationMs?: number | null;
  sizeBytes?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export const BROWSER_LOCAL_ASR = {
  provider: 'browser-whisper',
  model: 'onnx-community/whisper-tiny.en',
  revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
} as const;

export const BROWSER_LOCAL_TRANSLATION = {
  provider: 'browser-opus-mt',
  model: 'Xenova/opus-mt-en-vi',
  revision: '3f5f449333cbc7ecaa9eec16ee9e37682f036b8e',
} as const;

export type ClientInferenceCommitPayload = {
  expectedSourceGeneration: number;
  expectedSourceObjectKey: string;
  durationMs: number;
  asr: typeof BROWSER_LOCAL_ASR;
  translation: typeof BROWSER_LOCAL_TRANSLATION;
  segments: Array<{ id: string; startMs: number; endMs: number; sourceText: string }>;
  translations: Array<{ segmentId: string; translatedText: string }>;
};

export type ClientInferenceCommitResult = {
  projectId: string;
  sourceGeneration: number;
  sourceObjectKey: string;
  durationMs: number;
};

export type ClientInferenceState = {
  sourceGeneration: number;
  sourceObjectKey: string;
  asr: typeof BROWSER_LOCAL_ASR;
  translation: typeof BROWSER_LOCAL_TRANSLATION;
};

function projectPath(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

export function createProject(title: string, sourceLanguage: CloudProject['sourceLanguage']) {
  return apiFetch<CloudProject>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ title, sourceLanguage, targetLanguage: 'vi' }),
  });
}

export function listProjects() { return apiFetch<CloudProject[]>('/api/projects'); }

export function getProject(projectId: string) {
  return apiFetch<CloudProject>(projectPath(projectId));
}

export async function getClientInferenceState(projectId: string) {
  const result = await apiFetch<{ state: ClientInferenceState | null }>(
    `${projectPath(projectId)}/client-inference/vi`,
  );
  return result.state;
}

export function commitClientInference(projectId: string, payload: ClientInferenceCommitPayload) {
  return apiFetch<ClientInferenceCommitResult>(`${projectPath(projectId)}/client-inference/vi`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function fetchProjectSourceMedia(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<File> {
  const response = await fetchImpl(`${projectPath(projectId)}/media`);
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    let payload: unknown;
    if (contentType.includes('application/json')) {
      try { payload = await response.json(); } catch { payload = undefined; }
    }
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    throw new ApiError(
      response.status,
      typeof body.code === 'string' ? body.code : 'LOCAL_SOURCE_FETCH_FAILED',
      typeof body.message === 'string' ? body.message : 'Unable to fetch project source media.',
      payload,
    );
  }
  const blob = await response.blob();
  if (blob.size <= 0) {
    throw new ApiError(422, 'LOCAL_SOURCE_FETCH_FAILED', 'Project source media is empty.');
  }
  return new File([blob], `project-${projectId}-source`, {
    type: blob.type || response.headers.get('content-type') || 'application/octet-stream',
  });
}
