import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/routes/readiness';

const schema13 = {
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

describe('zero-container media readiness', () => {
  it('requires schema 13 and only the Stream source-path configuration before reporting ready', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() { return schema13 as T; },
        };
      },
    };

    const result = await checkReadiness(db, 'dg-secret', {
      stream: {},
      sourceSigningSecret: 'source-secret',
      publicOrigin: 'https://yupvox.qs3d.site',
    });

    expect(result).toMatchObject({
      ready: true,
      database: 'ready',
      schemaRevision: 13,
      media: { stream: 'ready' },
    });
  });

  it('does not require a separate Stream REST API token when the Workers Stream binding is present', async () => {
    const db = { prepare: () => ({ async first<T>() { return schema13 as T; } }) };
    const result = await checkReadiness(db, 'dg-secret', {
      stream: {},
      sourceSigningSecret: 'source-secret',
      publicOrigin: 'https://yupvox.qs3d.site',
    });
    expect(result.ready).toBe(true);
  });

  it('reports media unavailable when the signed source origin is incomplete', async () => {
    const db = { prepare: () => ({ async first<T>() { return schema13 as T; } }) };
    const result = await checkReadiness(db, 'dg-secret', { stream: {}, sourceSigningSecret: 'source-secret' });
    expect(result).toMatchObject({ ready: false, database: 'ready', schemaRevision: 13, media: { stream: 'unavailable' } });
  });
});
