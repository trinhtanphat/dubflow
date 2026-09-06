import { ApiError, apiFetch } from '../../lib/api/client';

export type TranslationStyle = 'neutral' | 'natural' | 'formal' | 'casual' | 'cinematic';
export type TargetLanguage = 'vi' | 'en' | 'zh' | 'ja' | 'ko';

export type TranslationSettings = {
  stylePreset: TranslationStyle;
  contextRevision: number;
  contextualAvailable: boolean;
};

export type GlossaryEntryInputDto = {
  targetLanguage?: TargetLanguage;
  sourceTerm: string;
  preferredTranslation: string;
  note?: string | null;
  caseSensitive: boolean;
};

export type GlossaryEntryDto = {
  id: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  sourceTerm: string;
  preferredTranslation: string;
  note: string | null;
  caseSensitive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TranslationContextSnapshotDto = {
  revision: number;
  style: TranslationStyle;
  glossary: GlossaryEntryDto[];
};

export type GlossaryListDto = {
  targetLanguage: TargetLanguage;
  contextRevision: number;
  glossary: GlossaryEntryDto[];
};

export type GlossaryMutationDto = {
  entry: GlossaryEntryDto;
  contextRevision: number;
  context: TranslationContextSnapshotDto;
};

export type GlossaryDeleteDto = {
  targetLanguage: TargetLanguage;
  contextRevision: number;
  context: TranslationContextSnapshotDto;
};

export class TranslationContextConflictError extends Error {
  constructor(public readonly canonical: TranslationContextSnapshotDto) {
    super('Translation settings changed elsewhere.');
    this.name = 'TranslationContextConflictError';
  }
}

const STYLES = new Set<TranslationStyle>(['neutral', 'natural', 'formal', 'casual', 'cinematic']);
const TARGETS = new Set<TargetLanguage>(['vi', 'en', 'zh', 'ja', 'ko']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTranslationStyle(value: unknown): value is TranslationStyle {
  return typeof value === 'string' && STYLES.has(value as TranslationStyle);
}

function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && TARGETS.has(value as TargetLanguage);
}

function isGlossaryEntry(value: unknown): value is GlossaryEntryDto {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.projectId === 'string'
    && isTargetLanguage(value.targetLanguage)
    && typeof value.sourceTerm === 'string'
    && typeof value.preferredTranslation === 'string'
    && (value.note === null || typeof value.note === 'string')
    && typeof value.caseSensitive === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function contextSnapshotFrom(value: unknown): TranslationContextSnapshotDto | null {
  if (!isRecord(value)
    || !Number.isInteger(value.revision)
    || (value.revision as number) < 1
    || !isTranslationStyle(value.style)
    || !Array.isArray(value.glossary)
    || !value.glossary.every(isGlossaryEntry)) {
    return null;
  }
  return {
    revision: value.revision as number,
    style: value.style,
    glossary: value.glossary,
  };
}

async function withContextConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError
      && error.status === 409
      && error.code === 'TRANSLATION_CONTEXT_CONFLICT'
      && isRecord(error.payload)) {
      const canonical = contextSnapshotFrom(error.payload.context);
      if (canonical) throw new TranslationContextConflictError(canonical);
    }
    throw error;
  }
}

function projectPath(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function glossaryPath(projectId: string, targetLanguage: TargetLanguage) {
  return `${projectPath(projectId)}/glossary?targetLanguage=${encodeURIComponent(targetLanguage)}`;
}

export function loadTranslationSettings(projectId: string) {
  return apiFetch<TranslationSettings>(`${projectPath(projectId)}/translation-settings`);
}

export function loadGlossary(projectId: string, targetLanguage: TargetLanguage = 'vi') {
  return apiFetch<GlossaryListDto>(glossaryPath(projectId, targetLanguage));
}

export function updateTranslationStyle(
  projectId: string,
  expectedContextRevision: number,
  stylePreset: TranslationStyle,
) {
  return withContextConflict(() => apiFetch<TranslationSettings>(
    `${projectPath(projectId)}/translation-settings`,
    {
      method: 'PATCH',
      body: JSON.stringify({ expectedContextRevision, stylePreset }),
    },
  ));
}

export function createGlossaryEntry(
  projectId: string,
  expectedContextRevision: number,
  input: GlossaryEntryInputDto,
) {
  const targetLanguage = input.targetLanguage ?? 'vi';
  return withContextConflict(() => apiFetch<GlossaryMutationDto>(
    `${projectPath(projectId)}/glossary`,
    {
      method: 'POST',
      body: JSON.stringify({ expectedContextRevision, ...input, targetLanguage }),
    },
  ));
}

export function updateGlossaryEntry(
  projectId: string,
  entryId: string,
  expectedContextRevision: number,
  input: GlossaryEntryInputDto,
) {
  const targetLanguage = input.targetLanguage ?? 'vi';
  return withContextConflict(() => apiFetch<GlossaryMutationDto>(
    `${projectPath(projectId)}/glossary/${encodeURIComponent(entryId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ expectedContextRevision, ...input, targetLanguage }),
    },
  ));
}

export function deleteGlossaryEntry(
  projectId: string,
  entryId: string,
  expectedContextRevision: number,
  targetLanguage: TargetLanguage = 'vi',
) {
  return withContextConflict(() => apiFetch<GlossaryDeleteDto>(
    `${projectPath(projectId)}/glossary/${encodeURIComponent(entryId)}?targetLanguage=${encodeURIComponent(targetLanguage)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ expectedContextRevision }),
    },
  ));
}
