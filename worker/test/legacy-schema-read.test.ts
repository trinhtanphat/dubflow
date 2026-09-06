import { describe, expect, it } from 'vitest';
import { ProjectRepository, type D1DatabaseLike, type D1StatementLike } from '../src/db/projects';
import { UsageRepository } from '../src/db/usage';

function projectLegacyDb(): D1DatabaseLike {
  const projectColumns = [
    'id', 'user_id', 'title', 'source_language', 'target_language', 'status',
    'source_object_key', 'duration_ms', 'size_bytes', 'created_at', 'updated_at',
  ];
  const row = {
    id: 'p1',
    user_id: 'dev-user',
    title: 'Legacy Project',
    source_language: 'en',
    target_language: 'vi',
    status: 'draft',
    source_object_key: 'projects/p1/source.mp4',
    duration_ms: 120000,
    size_bytes: 1024,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    target_languages_revision: 1,
    export_object_key: null,
  };

  return {
    prepare(sql: string): D1StatementLike {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) { values = next; return statement; },
        async run() { return { meta: { changes: 0 } }; },
        async all<T>() {
          if (/pragma_table_info|PRAGMA\s+table_info/i.test(sql)) {
            return { results: projectColumns.map((name) => ({ name })) as T[] };
          }
          if (/FROM\s+projects/i.test(sql)) {
            const select = sql.split(/FROM\s+projects/i, 1)[0]
              .replace(/\b1\s+AS\s+target_languages_revision\b/ig, '')
              .replace(/\bNULL\s+AS\s+export_object_key\b/ig, '');
            if (/\btarget_languages_revision\b/i.test(select)) throw new Error('no such column: target_languages_revision');
            if (/\bexport_object_key\b/i.test(select)) throw new Error('no such column: export_object_key');
            return { results: values[0] === 'dev-user' ? [row as T] : [] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/pragma_table_info|PRAGMA\s+table_info/i.test(sql)) {
            return null;
          }
          if (/FROM\s+projects/i.test(sql)) {
            const select = sql.split(/FROM\s+projects/i, 1)[0]
              .replace(/\b1\s+AS\s+target_languages_revision\b/ig, '')
              .replace(/\bNULL\s+AS\s+export_object_key\b/ig, '');
            if (/\btarget_languages_revision\b/i.test(select)) throw new Error('no such column: target_languages_revision');
            if (/\bexport_object_key\b/i.test(select)) throw new Error('no such column: export_object_key');
            return (values[0] === 'p1' && values[1] === 'dev-user' ? row : null) as T | null;
          }
          return null;
        },
      };
      return statement;
    },
  };
}

function usageLegacyDb(): D1DatabaseLike {
  const usageColumns = ['id', 'user_id', 'project_id', 'kind', 'units', 'provider', 'cost_basis', 'created_at'];
  const usageRows = [{ kind: 'asr_audio_second', units: 12.5, provider: 'deepgram-nova-3' }];

  return {
    prepare(sql: string): D1StatementLike {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) { values = next; return statement; },
        async run() { return { meta: { changes: 0 } }; },
        async all<T>() {
          if (/pragma_table_info|PRAGMA\s+table_info/i.test(sql)) {
            return { results: usageColumns.map((name) => ({ name })) as T[] };
          }
          if (/FROM\s+usage_events/i.test(sql)) {
            if (/\bphase\b/i.test(sql)) throw new Error('no such column: phase');
            return { results: values.includes('dev-user') ? usageRows as T[] : [] as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/SELECT\s+credit_balance\s+FROM\s+users/i.test(sql)) {
            return (values[0] === 'dev-user' ? { credit_balance: 50000 } : null) as T | null;
          }
          if (/SELECT\s+id\s+FROM\s+projects/i.test(sql)) {
            return (values[0] === 'p1' && values[1] === 'dev-user' ? { id: 'p1' } : null) as T | null;
          }
          return null;
        },
      };
      return statement;
    },
  };
}

describe('legacy production schema read compatibility', () => {
  it('lists and reads projects before export and multi-language columns exist', async () => {
    const repo = new ProjectRepository(projectLegacyDb());

    await expect(repo.listByUser('dev-user')).resolves.toEqual([
      {
        id: 'p1',
        userId: 'dev-user',
        title: 'Legacy Project',
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        targetLanguagesRevision: 1,
        sourceGeneration: 1,
        status: 'draft',
        sourceObjectKey: 'projects/p1/source.mp4',
        exportObjectKey: null,
        durationMs: 120000,
        sizeBytes: 1024,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
    ]);
    await expect(repo.getByIdForUser('p1', 'dev-user')).resolves.toMatchObject({
      id: 'p1',
      targetLanguagesRevision: 1,
      sourceGeneration: 1,
      exportObjectKey: null,
    });
  });

  it('summarizes legacy usage rows before the phase column exists', async () => {
    const repo = new UsageRepository(usageLegacyDb());

    await expect(repo.summarizeForUser('dev-user')).resolves.toEqual({
      totals: {
        asrAudioSeconds: 12.5,
        translationCharacters: 0,
        ttsAudioSeconds: 0,
        renderSeconds: 0,
        dialogueSeparationSeconds: 0,
      },
      providers: {
        'deepgram-nova-3': {
          asrAudioSeconds: 12.5,
          translationCharacters: 0,
          ttsAudioSeconds: 0,
          renderSeconds: 0,
          dialogueSeparationSeconds: 0,
        },
      },
    });
    await expect(repo.getCreditBalance('dev-user')).resolves.toBe(50000);
  });
});
