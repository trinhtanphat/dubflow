import { ApiError, apiFetch } from '../../lib/api/client';

export type TargetLanguage = 'vi' | 'en' | 'zh' | 'ja' | 'ko';
export type ProjectLanguageStatus = 'pending' | 'translating' | 'needs_review' | 'ready' | 'exporting' | 'completed' | 'failed';

export type ProjectLanguageConfigDto = {
  revision: number;
  languages: Array<{ targetLanguage: TargetLanguage; status: ProjectLanguageStatus }>;
};

export type SegmentTranslationDto = {
  segmentId: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  translatedText: string;
  translationEngine: string | null;
  translationStatus: string;
  translationContextRevision: number | null;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
};

export type TranslationVariantDto = {
  segmentId: string;
  speakerId: string | null;
  startMs: number;
  endMs: number;
  sourceText: string;
  sourceVersion: number;
  translation: SegmentTranslationDto | null;
};

export type JobLaunchDto = {
  jobId: string;
  workflowId: string;
  status: 'queued';
  targetLanguage: TargetLanguage;
};

export class ProjectLanguagesConflictError extends Error {
  constructor(public readonly canonical: ProjectLanguageConfigDto) {
    super('Project languages changed elsewhere.');
    this.name = 'ProjectLanguagesConflictError';
  }
}

export class TranslationVariantConflictError extends Error {
  constructor(public readonly canonical: SegmentTranslationDto) {
    super('Translation variant changed elsewhere.');
    this.name = 'TranslationVariantConflictError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function projectPath(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

async function withLanguageConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError
      && error.status === 409
      && error.code === 'PROJECT_LANGUAGES_CONFLICT'
      && isRecord(error.payload)
      && isRecord(error.payload.canonical)) {
      throw new ProjectLanguagesConflictError(error.payload.canonical as ProjectLanguageConfigDto);
    }
    throw error;
  }
}

async function withVariantConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError
      && error.status === 409
      && error.code === 'TRANSLATION_VARIANT_CONFLICT'
      && isRecord(error.payload)
      && isRecord(error.payload.canonical)) {
      throw new TranslationVariantConflictError(error.payload.canonical as SegmentTranslationDto);
    }
    throw error;
  }
}

export function getProjectLanguages(projectId: string) {
  return apiFetch<ProjectLanguageConfigDto>(`${projectPath(projectId)}/languages`);
}

export function patchProjectLanguages(
  projectId: string,
  targetLanguages: TargetLanguage[],
  expectedLanguagesRevision: number,
) {
  return withLanguageConflict(() => apiFetch<ProjectLanguageConfigDto>(
    `${projectPath(projectId)}/languages`,
    {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: expectedLanguagesRevision, targetLanguages }),
    },
  ));
}

export async function getTranslationVariants(
  projectId: string,
  targetLanguage: TargetLanguage,
): Promise<TranslationVariantDto[]> {
  const response = await apiFetch<{ targetLanguage: TargetLanguage; segments: TranslationVariantDto[] }>(
    `${projectPath(projectId)}/translations/${encodeURIComponent(targetLanguage)}`,
  );
  return response.segments;
}

export async function patchTranslationVariant(
  projectId: string,
  targetLanguage: TargetLanguage,
  segmentId: string,
  expectedVersion: number,
  translatedText: string,
): Promise<SegmentTranslationDto> {
  const response = await withVariantConflict(() => apiFetch<{ translation: SegmentTranslationDto }>(
    `${projectPath(projectId)}/translations/${encodeURIComponent(targetLanguage)}/${encodeURIComponent(segmentId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ expectedVersion, translatedText }),
    },
  ));
  return response.translation;
}

export function processTargetLanguage(projectId: string, targetLanguage: TargetLanguage) {
  return apiFetch<JobLaunchDto>(
    `${projectPath(projectId)}/translations/${encodeURIComponent(targetLanguage)}/process`,
    { method: 'POST' },
  );
}
