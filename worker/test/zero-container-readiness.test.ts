import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/routes/readiness';

const schema11 = {
  projects_table: 1,
  project_export_column: 1,
  usage_operation_column: 1,
  target_languages_revision_column: 1,
  project_target_languages_table: 1,
  project_exports_output_column: 1,
  stream_video_uid_column: 1,
  stream_source_object_key_column: 1,
  stream_ready_at_column: 1,
};

describe('zero-container media readiness', () => {
  it('requires schema 11 and Stream configuration before reporting ready', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return schema11 as T;
          },
        };
      },
    };

    const result = await (checkReadiness as unknown as (
      db: typeof db,
      deepgramApiKey: string,
      media: {
        stream: object;
        accountId: string;
        sourceSigningSecret: string;
        streamApiToken: string;
      },
    ) => Promise<unknown>)(db, 'dg-secret', {
      stream: {},
      accountId: '50afb4fd3c4c7a1f3e1bdb7f22d4af7f',
      sourceSigningSecret: 'source-secret',
      streamApiToken: 'stream-token',
    });

    expect(result).toMatchObject({
      ready: true,
      database: 'ready',
      schemaRevision: 11,
      media: { stream: 'ready' },
    });
  });
});
