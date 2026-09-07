import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/routes/readiness';

const schema14 = {
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
        async first<T>() { return schema14 as T; },
      };
    },
  };
}

const voiceReady = {
  elevenLabsApiKey: 'elevenlabs-secret',
  elevenLabsDefaultVoiceId: 'voice-id',
};

describe('R2-only media readiness', () => {
  it('reports schema 14 ready with R2/remux and configured standard dubbing voice', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      r2: {},
      publicOrigin: 'https://yupvox.qs3d.site',
      sourceSigningSecret: 'source-secret',
      remuxReady: true,
      ...voiceReady,
    });

    expect(result).toMatchObject({
      ready: true,
      database: 'ready',
      schemaRevision: 14,
      media: { r2: 'ready', remux: 'ready' },
      voice: { provider: 'elevenlabs', status: 'ready' },
    });
  });

  it('reports R2 media unavailable when the signed source origin is incomplete', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      r2: {},
      sourceSigningSecret: 'source-secret',
      remuxReady: true,
      ...voiceReady,
    });

    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 14,
      media: { r2: 'unavailable', remux: 'ready' },
      voice: { provider: 'elevenlabs', status: 'ready' },
    });
  });

  it('fails readiness when the remux runtime self-check is unavailable without requiring Stream credentials', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      r2: {},
      publicOrigin: 'https://yupvox.qs3d.site',
      sourceSigningSecret: 'source-secret',
      remuxReady: false,
      ...voiceReady,
    });

    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 14,
      media: { r2: 'ready', remux: 'unavailable' },
      voice: { provider: 'elevenlabs', status: 'ready' },
    });
  });

  it('fails closed when ElevenLabs API key or default voice id is missing', async () => {
    const base = {
      r2: {},
      publicOrigin: 'https://yupvox.qs3d.site',
      sourceSigningSecret: 'source-secret',
      remuxReady: true,
    };

    const missingKey = await checkReadiness(schemaDb(), 'dg-secret', {
      ...base,
      elevenLabsDefaultVoiceId: 'voice-id',
    });
    expect(missingKey).toMatchObject({
      ready: false,
      voice: { provider: 'elevenlabs', status: 'unavailable' },
    });

    const missingVoice = await checkReadiness(schemaDb(), 'dg-secret', {
      ...base,
      elevenLabsApiKey: 'elevenlabs-secret',
    });
    expect(missingVoice).toMatchObject({
      ready: false,
      voice: { provider: 'elevenlabs', status: 'unavailable' },
    });
  });
});
