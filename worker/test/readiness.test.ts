import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/routes/readiness';

const fullSchema = {
  projects_table: 1,
  project_export_column: 1,
  usage_operation_column: 1,
  target_languages_revision_column: 1,
  project_target_languages_table: 1,
  project_exports_output_column: 1,
  project_source_generation_column: 1,
  project_exports_audio_mode_column: 1,
  project_audio_stems_table: 1,
  stream_video_uid_column: 1,
  stream_source_object_key_column: 1,
  stream_ready_at_column: 1,
  export_stream_video_uid_column: 1,
  export_stream_source_object_key_column: 1,
  project_exports_lip_sync_status_column: 1,
  provider_media_grants_table: 1,
};

describe('checkReadiness', () => {
  it('reports ready and configured chunk-scoped diarization only after paid Deepgram ASR is explicitly enabled', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return fullSchema as T;
          },
        };
      },
    };

    await expect(checkReadiness(db, ' dg-secret ', undefined, 'true')).resolves.toEqual({
      ready: true,
      service: 'dubflow',
      database: 'ready',
      schemaRevision: 14,
      asr: {
        provider: 'deepgram-nova-3',
        speakerDiarization: 'configured',
        speakerIdentityScope: 'chunk',
      },
      inference: { workersAI: 'disabled' },
    });
  });

  it('keeps infrastructure ready but reports ASR unavailable when only the Deepgram secret exists', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return fullSchema as T;
          },
        };
      },
    };

    await expect(checkReadiness(db, ' dg-secret ')).resolves.toEqual({
      ready: true,
      service: 'dubflow',
      database: 'ready',
      schemaRevision: 14,
      asr: {
        provider: 'unavailable',
        speakerDiarization: 'unavailable',
        speakerIdentityScope: 'none',
      },
      inference: { workersAI: 'disabled' },
    });
  });

  it('keeps the service ready on Workers AI only after explicit paid opt-in while reporting diarization unavailable', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return fullSchema as T;
          },
        };
      },
    };

    await expect(checkReadiness(db, undefined, undefined, undefined, 'true')).resolves.toEqual({
      ready: true,
      service: 'dubflow',
      database: 'ready',
      schemaRevision: 14,
      asr: {
        provider: 'workers-ai-whisper-large-v3-turbo',
        speakerDiarization: 'unavailable',
        speakerIdentityScope: 'none',
      },
      inference: { workersAI: 'enabled' },
    });
  });

  it('fails closed when the projects table exists but required later migrations are missing', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return {
              projects_table: 1,
              project_export_column: 1,
              usage_operation_column: 1,
              target_languages_revision_column: 1,
              project_target_languages_table: 1,
              project_exports_output_column: 1,
              project_source_generation_column: 0,
              project_exports_audio_mode_column: 0,
              project_audio_stems_table: 0,
              stream_video_uid_column: 0,
              stream_source_object_key_column: 0,
              stream_ready_at_column: 0,
              export_stream_video_uid_column: 0,
              export_stream_source_object_key_column: 0,
              project_exports_lip_sync_status_column: 0,
              provider_media_grants_table: 0,
            } as T;
          },
        };
      },
    };

    await expect(checkReadiness(db, 'dg-secret', undefined, 'true')).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'missing-schema',
      schemaRevision: null,
      asr: {
        provider: 'deepgram-nova-3',
        speakerDiarization: 'configured',
        speakerIdentityScope: 'chunk',
      },
      inference: { workersAI: 'disabled' },
    });
  });

  it('fails closed before migrations create the projects table while still reporting ASR capability truthfully', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return null as T | null;
          },
        };
      },
    };

    await expect(checkReadiness(db, 'dg-secret', undefined, 'true')).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'missing-schema',
      schemaRevision: null,
      asr: {
        provider: 'deepgram-nova-3',
        speakerDiarization: 'configured',
        speakerIdentityScope: 'chunk',
      },
      inference: { workersAI: 'disabled' },
    });
  });

  it('fails closed when D1 is unavailable while paid inference remains disabled', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            throw new Error('D1 unavailable');
          },
        };
      },
    };

    await expect(checkReadiness(db)).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'unavailable',
      schemaRevision: null,
      asr: {
        provider: 'unavailable',
        speakerDiarization: 'unavailable',
        speakerIdentityScope: 'none',
      },
      inference: { workersAI: 'disabled' },
    });
  });
});
