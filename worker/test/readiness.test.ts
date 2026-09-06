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
};

describe('checkReadiness', () => {
  it('reports ready and configured chunk-scoped diarization only after the current production schema exists', async () => {
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
      schemaRevision: 11,
      asr: {
        provider: 'deepgram-nova-3',
        speakerDiarization: 'configured',
        speakerIdentityScope: 'chunk',
      },
    });
  });

  it('keeps the service ready on the Workers AI fallback but reports diarization unavailable', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return fullSchema as T;
          },
        };
      },
    };

    await expect(checkReadiness(db)).resolves.toEqual({
      ready: true,
      service: 'dubflow',
      database: 'ready',
      schemaRevision: 11,
      asr: {
        provider: 'workers-ai-whisper-large-v3-turbo',
        speakerDiarization: 'unavailable',
        speakerIdentityScope: 'none',
      },
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
            } as T;
          },
        };
      },
    };

    await expect(checkReadiness(db, 'dg-secret')).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'missing-schema',
      schemaRevision: null,
      asr: {
        provider: 'deepgram-nova-3',
        speakerDiarization: 'configured',
        speakerIdentityScope: 'chunk',
      },
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

    await expect(checkReadiness(db, 'dg-secret')).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'missing-schema',
      schemaRevision: null,
      asr: {
        provider: 'deepgram-nova-3',
        speakerDiarization: 'configured',
        speakerIdentityScope: 'chunk',
      },
    });
  });

  it('fails closed when D1 is unavailable while still reporting the fallback capability', async () => {
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
        provider: 'workers-ai-whisper-large-v3-turbo',
        speakerDiarization: 'unavailable',
        speakerIdentityScope: 'none',
      },
    });
  });
});
