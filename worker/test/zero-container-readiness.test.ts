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

const completeMediaConfig = {
  stream: {},
  accountId: '6c5207813df3d5b83b9508125e0e9e12',
  publicOrigin: 'https://yupvox.qs3d.site',
  sourceSigningSecret: 'source-secret',
  streamApiToken: 'stream-token',
};

describe('zero-container media readiness', () => {
  it('requires schema 13, complete Stream configuration, and a successful account capability probe before reporting ready', async () => {
    const requests: Request[] = [];
    const result = await checkReadiness(
      schemaDb(),
      'dg-secret',
      completeMediaConfig,
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/6c5207813df3d5b83b9508125e0e9e12/stream?per_page=1');
    expect(requests[0].headers.get('authorization')).toBe('Bearer stream-token');
    expect(result).toMatchObject({
      ready: true,
      database: 'ready',
      schemaRevision: 13,
      media: { stream: 'ready' },
    });
  });

  it('fails closed when the Cloudflare account reports Stream unavailable even though bindings and credentials are present', async () => {
    const result = await checkReadiness(
      schemaDb(),
      'dg-secret',
      completeMediaConfig,
      async () => new Response(JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: 'Cloudflare Stream not enabled' }],
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 13,
      media: { stream: 'unavailable' },
    });
  });

  it('reports media unavailable when the signed source origin is incomplete without probing the account', async () => {
    let called = false;
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      stream: {},
      accountId: '6c5207813df3d5b83b9508125e0e9e12',
      sourceSigningSecret: 'source-secret',
      streamApiToken: 'stream-token',
    }, async () => {
      called = true;
      return new Response(null, { status: 200 });
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 13,
      media: { stream: 'unavailable' },
    });
  });

  it('keeps Stream REST credentials required for final dubbed MP4 publication without probing incomplete config', async () => {
    let called = false;
    const result = await checkReadiness(schemaDb(), 'dg-secret', {
      stream: {},
      publicOrigin: 'https://yupvox.qs3d.site',
      sourceSigningSecret: 'source-secret',
    }, async () => {
      called = true;
      return new Response(null, { status: 200 });
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({
      ready: false,
      database: 'ready',
      schemaRevision: 13,
      media: { stream: 'unavailable' },
    });
  });
});
