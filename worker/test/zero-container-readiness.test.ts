import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/routes/readiness';

const schema12 = {
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
};

describe('zero-container media readiness', () => {
  it('requires schema 12 and Stream configuration before reporting ready', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() { return schema12 as T; },
        };
      },
    };

    const result = await checkReadiness(db, 'dg-secret', {
      stream: {},
      accountId: '50afb4fd3c4c7a1f3e1bdb7f22d4af7f',
      sourceSigningSecret: 'source-secret',
      streamApiToken: 'stream-token',
    });

    expect(result).toMatchObject({
      ready: true,
      database: 'ready',
      schemaRevision: 12,
      media: { stream: 'ready' },
    });
  });

  it('reports media unavailable when Stream write configuration is incomplete', async () => {
    const db = { prepare: () => ({ async first<T>() { return schema12 as T; } }) };
    const result = await checkReadiness(db, 'dg-secret', { stream: {}, accountId: 'account' });
    expect(result).toMatchObject({ ready: false, database: 'ready', schemaRevision: 12, media: { stream: 'unavailable' } });
  });
});
