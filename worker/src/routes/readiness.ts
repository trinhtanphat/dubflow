import { asrCapabilities, type AsrCapabilities } from '../services/asr/router';

export interface ReadinessStatementLike {
  first<T>(): Promise<T | null>;
}

export interface ReadinessDatabaseLike {
  prepare(sql: string): ReadinessStatementLike;
}

export type MediaReadinessConfig = {
  r2?: unknown;
  publicOrigin?: string;
  sourceSigningSecret?: string;
  remuxReady?: boolean;
};

export type MediaReadiness = {
  r2: 'ready' | 'unavailable';
  remux: 'ready' | 'unavailable';
};

export type VoiceReadinessConfig = {
  apiKey?: string;
  defaultVoiceId?: string;
};

export type VoiceReadiness = {
  provider: 'elevenlabs';
  configured: boolean;
};

export type ReadinessResult = {
  ready: boolean;
  service: 'dubflow';
  database: 'ready' | 'missing-schema' | 'unavailable';
  schemaRevision: 14 | null;
  asr: AsrCapabilities;
  voice?: VoiceReadiness;
  media?: MediaReadiness;
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
  stream_video_uid_column: number;
  stream_source_object_key_column: number;
  stream_ready_at_column: number;
  export_stream_video_uid_column: number;
  export_stream_source_object_key_column: number;
  project_exports_lip_sync_status_column: number;
  provider_media_grants_table: number;
};

const CURRENT_SCHEMA_REVISION = 14 as const;

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
    Number(row.project_audio_stems_table) === 1 &&
    Number(row.stream_video_uid_column) === 1 &&
    Number(row.stream_source_object_key_column) === 1 &&
    Number(row.stream_ready_at_column) === 1 &&
    Number(row.export_stream_video_uid_column) === 1 &&
    Number(row.export_stream_source_object_key_column) === 1 &&
    Number(row.project_exports_lip_sync_status_column) === 1 &&
    Number(row.provider_media_grants_table) === 1
  );
}

function mediaStatus(config?: MediaReadinessConfig): MediaReadiness | undefined {
  if (!config) return undefined;
  const r2Ready = Boolean(
    config.r2
    && config.publicOrigin?.trim()
    && config.sourceSigningSecret?.trim()
  );
  return {
    r2: r2Ready ? 'ready' : 'unavailable',
    remux: config.remuxReady === true ? 'ready' : 'unavailable',
  };
}

function voiceStatus(config?: VoiceReadinessConfig): VoiceReadiness | undefined {
  if (!config) return undefined;
  return {
    provider: 'elevenlabs',
    configured: Boolean(config.apiKey?.trim() && config.defaultVoiceId?.trim()),
  };
}

function result(
  input: Omit<ReadinessResult, 'ready'>,
  media?: MediaReadiness,
  voice?: VoiceReadiness,
): ReadinessResult {
  const mediaReady = !media || (media.r2 === 'ready' && media.remux === 'ready');
  const productionProvidersReady = !media || (
    input.asr.provider === 'deepgram-nova-3'
    && voice?.configured === true
  );
  const ready = input.database === 'ready' && mediaReady && productionProvidersReady;
  return {
    ready,
    ...input,
    ...(voice ? { voice } : {}),
    ...(media ? { media } : {}),
  };
}

export async function checkReadiness(
  db: ReadinessDatabaseLike,
  deepgramApiKey?: string,
  mediaConfig?: MediaReadinessConfig,
  voiceConfig?: VoiceReadinessConfig,
): Promise<ReadinessResult> {
  const asr = asrCapabilities(deepgramApiKey);
  const media = mediaStatus(mediaConfig);
  const voice = voiceStatus(voiceConfig);
  try {
    const row = await db.prepare(`
      SELECT
        EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects') AS projects_table,
        EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name = 'export_object_key') AS project_export_column,
        EXISTS(SELECT 1 FROM pragma_table_info('usage_events') WHERE name = 'operation_key') AS usage_operation_column,
        EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name = 'target_languages_revision') AS target_languages_revision_column,
        EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_target_languages') AS project_target_languages_table,
        EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'output') AS project_exports_output_column,
        EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name = 'source_generation') AS project_source_generation_column,
        EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'audio_mode') AS project_exports_audio_mode_column,
        EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_audio_stems') AS project_audio_stems_table,
        EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name = 'stream_video_uid') AS stream_video_uid_column,
        EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name = 'stream_source_object_key') AS stream_source_object_key_column,
        EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name = 'stream_ready_at') AS stream_ready_at_column,
        EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'stream_video_uid') AS export_stream_video_uid_column,
        EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'stream_source_object_key') AS export_stream_source_object_key_column,
        EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'lip_sync_status') AS project_exports_lip_sync_status_column,
        EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_media_grants') AS provider_media_grants_table
    `).first<ReadinessSchemaRow>();

    if (!hasCurrentSchema(row)) {
      return result({ service: 'dubflow', database: 'missing-schema', schemaRevision: null, asr }, media, voice);
    }
    return result({ service: 'dubflow', database: 'ready', schemaRevision: CURRENT_SCHEMA_REVISION, asr }, media, voice);
  } catch {
    return result({ service: 'dubflow', database: 'unavailable', schemaRevision: null, asr }, media, voice);
  }
}
