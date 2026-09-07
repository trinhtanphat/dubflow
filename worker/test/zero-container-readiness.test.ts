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

function schemaDb() {
  return {
    prepare() {
      return {
        async first<T>() { return schema13 as T; },
      };
    },
  };
}

describe('zero-container media readiness', () => {
  it('requires schema 13 and complete Stream configuration before reporting ready', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      stream: {},
      accountId: '6c5207813df3d5b83b9508125e0e9e12',
      publicOrigin: 'https://yupvox.qs3d.site',
      sourceSigningSecret: 'source-secret',
      streamApiToken: 'stream-token',
    });

    expect(result).toMatchObject({
      ready: true,
      database: 'ready',
      schemaRevision: 13,
      media: { stream: 'ready' },
    });
  });

  it('reports media unavailable when the signed source origin is incomplete', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      stream: {},
      accountId: '6c5207813df3d5b83b9508125e0e9e12',
      sourceSigningSecret: 'source-secret',
      streamApiToken: 'stream-token',
    });

    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 13,
      media: { stream: 'unavailable' },
    });
  });

  it('keeps Stream REST credentials required for final dubbed MP4 publication', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      stream: {},
      publicOrigin: 'https://yupvox.qs3d.site',
      sourceSigningSecret: 'source-secret',
    });

    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 13,
      media: { stream: 'unavailable' },
    });
  });
});
