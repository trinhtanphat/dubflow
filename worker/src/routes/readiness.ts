import { asrCapabilities, type AsrCapabilities } from '../services/asr/router';

export interface ReadinessStatementLike {
  first<T>(): Promise<T | null>;
}

export interface ReadinessDatabaseLike {
  prepare(sql: string): ReadinessStatementLike;
}

export type ReadinessResult = {
  ready: boolean;
  service: 'dubflow';
  database: 'ready' | 'missing-schema' | 'unavailable';
  schemaRevision: 11 | null;
  asr: AsrCapabilities;
};

type ReadinessSchemaRow = {
  projects_table: number;
  project_export_column: number;
  usage_operation_column: number;
  target_languages_revision_column: number;
  project_target_languages_table: number;
  project_exports_output_column: number;
  project_source_generation_column: number;
  project_exports_audio_mode_column: number;
  project_audio_stems_table: number;
};

const CURRENT_SCHEMA_REVISION = 11 as const;

function hasCurrentSchema(row: ReadinessSchemaRow | null): boolean {
  if (!row) return false;
  return (
    Number(row.projects_table) === 1 &&
    Number(row.project_export_column) === 1 &&
    Number(row.usage_operation_column) === 1 &&
    Number(row.target_languages_revision_column) === 1 &&
    Number(row.project_target_languages_table) === 1 &&
    Number(row.project_exports_output_column) === 1 &&
    Number(row.project_source_generation_column) === 1 &&
    Number(row.project_exports_audio_mode_column) === 1 &&
    Number(row.project_audio_stems_table) === 1
  );
}

export async function checkReadiness(db: ReadinessDatabaseLike, deepgramApiKey?: string): Promise<ReadinessResult> {
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
          WHERE name = 'source_generation'
        ) AS project_source_generation_column,
        EXISTS(
          SELECT 1 FROM pragma_table_info('project_exports')
          WHERE name = 'audio_mode'
        ) AS project_exports_audio_mode_column,
        EXISTS(
          SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'project_audio_stems'
        ) AS project_audio_stems_table
    `).first<ReadinessSchemaRow>();

    if (!hasCurrentSchema(row)) {
      return {
        ready: false,
        service: 'dubflow',
        database: 'missing-schema',
        schemaRevision: null,
        asr,
      };
    }

    return {
      ready: true,
      service: 'dubflow',
      database: 'ready',
      schemaRevision: CURRENT_SCHEMA_REVISION,
      asr,
    };
  } catch {
    return {
      ready: false,
      service: 'dubflow',
      database: 'unavailable',
      schemaRevision: null,
      asr,
    };
  }
}
