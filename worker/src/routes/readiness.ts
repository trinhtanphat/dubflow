import { asrCapabilities, type AsrCapabilities } from '../services/asr/router';
import type { SeparationCapabilities } from '../services/separation/types';

export interface ReadinessStatementLike {
  first<T>(): Promise<T | null>;
}

export interface ReadinessDatabaseLike {
  prepare(sql: string): ReadinessStatementLike;
}

type ReadinessSeparationCapabilities = Pick<
  SeparationCapabilities,
  'configured' | 'qualified' | 'provider' | 'modelId' | 'modelDigest' | 'maxDurationMs'
>;

export type ReadinessResult = {
  ready: boolean;
  service: 'dubflow';
  database: 'ready' | 'missing-schema' | 'unavailable';
  asr: AsrCapabilities;
  separation?: ReadinessSeparationCapabilities;
};

type ReadinessSchemaRow = {
  projects_table: number;
  project_export_column: number;
  usage_operation_column: number;
  target_languages_revision_column: number;
  project_target_languages_table: number;
  project_exports_output_column: number;
  source_revision_column: number;
  project_audio_separations_table: number;
  project_exports_mix_mode_column: number;
};

function hasCurrentSchema(row: ReadinessSchemaRow | null): boolean {
  if (!row) return false;
  return (
    Number(row.projects_table) === 1 &&
    Number(row.project_export_column) === 1 &&
    Number(row.usage_operation_column) === 1 &&
    Number(row.target_languages_revision_column) === 1 &&
    Number(row.project_target_languages_table) === 1 &&
    Number(row.project_exports_output_column) === 1 &&
    Number(row.source_revision_column) === 1 &&
    Number(row.project_audio_separations_table) === 1 &&
    Number(row.project_exports_mix_mode_column) === 1
  );
}

function result(
  ready: boolean,
  database: ReadinessResult['database'],
  asr: AsrCapabilities,
  separation?: ReadinessSeparationCapabilities,
): ReadinessResult {
  return {
    ready,
    service: 'dubflow',
    database,
    asr,
    ...(separation ? { separation } : {}),
  };
}

export async function checkReadiness(
  db: ReadinessDatabaseLike,
  deepgramApiKey?: string,
  separation?: ReadinessSeparationCapabilities,
): Promise<ReadinessResult> {
  const asr = asrCapabilities(deepgramApiKey);
  try {
    const row = await db.prepare(`
      SELECT
        EXISTS(
          SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'projects'
        ) AS projects_table,
        EXISTS(
          SELECT 1 FROM pragma_table_info('projects')
          WHERE name = 'export_object_key'
        ) AS project_export_column,
        EXISTS(
          SELECT 1 FROM pragma_table_info('usage_events')
          WHERE name = 'operation_key'
        ) AS usage_operation_column,
        EXISTS(
          SELECT 1 FROM pragma_table_info('projects')
          WHERE name = 'target_languages_revision'
        ) AS target_languages_revision_column,
        EXISTS(
          SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'project_target_languages'
        ) AS project_target_languages_table,
        EXISTS(
          SELECT 1 FROM pragma_table_info('project_exports')
          WHERE name = 'output'
        ) AS project_exports_output_column,
        EXISTS(
          SELECT 1 FROM pragma_table_info('projects')
          WHERE name = 'source_revision'
        ) AS source_revision_column,
        EXISTS(
          SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'project_audio_separations'
        ) AS project_audio_separations_table,
        EXISTS(
          SELECT 1 FROM pragma_table_info('project_exports')
          WHERE name = 'mix_mode'
        ) AS project_exports_mix_mode_column
    `).first<ReadinessSchemaRow>();

    if (!hasCurrentSchema(row)) {
      return result(false, 'missing-schema', asr, separation);
    }

    return result(true, 'ready', asr, separation);
  } catch {
    return result(false, 'unavailable', asr, separation);
  }
}
