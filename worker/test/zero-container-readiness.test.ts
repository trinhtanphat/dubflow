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

const mediaReady = {
  r2: {},
  publicOrigin: 'https://yupvox.qs3d.site',
  sourceSigningSecret: 'source-secret',
  remuxReady: true,
};

const voiceReady = {
  apiKey: 'elevenlabs-secret',
  defaultVoiceId: 'voice-id',
};

describe('R2-only media readiness', () => {
  it('reports schema 14 ready only with R2/remux plus remote ASR and production voice configuration', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', mediaReady, voiceReady);

    expect(result).toMatchObject({
      ready: true,
      database: 'ready',
      schemaRevision: 14,
      asr: { provider: 'deepgram-nova-3' },
      voice: { provider: 'elevenlabs', configured: true },
      media: { r2: 'ready', remux: 'ready' },
    });
  });

  it('fails production readiness when remote ASR is unavailable even though R2/remux are ready', async () => {
    const result = await checkReadiness(schemaDb(), undefined, mediaReady, voiceReady);

    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 14,
      asr: { provider: 'workers-ai-whisper-large-v3-turbo' },
      voice: { provider: 'elevenlabs', configured: true },
      media: { r2: 'ready', remux: 'ready' },
    });
  });

  it('fails production readiness when the ElevenLabs key/default voice contract is incomplete', async () => {
    const missingVoice = await checkReadiness(schemaDb(), 'dg-secret', mediaReady, {
      apiKey: 'elevenlabs-secret',
      defaultVoiceId: '',
    });

    expect(missingVoice).toMatchObject({
      ready: false,
      voice: { provider: 'elevenlabs', configured: false },
    });
  });

  it('reports R2 media unavailable when the signed source origin is incomplete', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      r2: {},
      sourceSigningSecret: 'source-secret',
      remuxReady: true,
    }, voiceReady);

    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 14,
      media: { r2: 'unavailable', remux: 'ready' },
    });
  });

  it('fails readiness when the remux runtime self-check is unavailable without requiring Stream credentials', async () => {
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      r2: {},
      publicOrigin: 'https://yupvox.qs3d.site',
      sourceSigningSecret: 'source-secret',
      remuxReady: false,
    }, voiceReady);

    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 14,
      media: { r2: 'ready', remux: 'unavailable' },
    });
  });
});
