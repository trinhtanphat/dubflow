import { describe, expect, it } from 'vitest';
import { SpeakerRepository } from '../src/db/speakers';

type Call = { sql: string; values: unknown[] };

function statefulDb() {
  const calls: Call[] = [];
  const speakerRow = {
    id: 'speaker-1', project_id: 'p1', label: 'SPEAKER_00', display_name: 'Nhân vật 1',
    voice_provider: null, voice_id: null, avatar_object_key: null,
  };
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async run() { calls.push({ sql, values }); return {}; },
        async all<T>() { return { results: [speakerRow] as T[] }; },
        async first<T>() {
          if (/FROM speakers s JOIN projects p/i.test(sql)) return speakerRow as T;
          if (/SELECT id, status FROM projects/i.test(sql)) return { id: 'p1', status: 'needs_review' } as T;
          return null as T | null;
        },
      };
    },
    async batch(statements: any[]) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
  return { db: db as any, calls };
}

describe('speaker metadata persistence', () => {
  it('invalidates only the assigned speaker audio and final export when voice id changes', async () => {
    const { db, calls } = statefulDb();
    const repo = new SpeakerRepository(db);
    const updated = await repo.update('p1', 'speaker-1', 'dev-user', { voiceId: 'voice-heroine' });

    expect(updated).toMatchObject({ voiceProvider: 'elevenlabs', voiceId: 'voice-heroine' });
    expect(calls.some((call) => /UPDATE segments/i.test(call.sql)
      && /speaker_id\s*=\s*\?/i.test(call.sql)
      && /dubbed_object_key\s*=\s*NULL/i.test(call.sql)
      && call.values.includes('speaker-1'))).toBe(true);
    expect(calls.some((call) => /UPDATE projects/i.test(call.sql)
      && /export_object_key\s*=\s*NULL/i.test(call.sql)
      && /status\s*=\s*'needs_review'/i.test(call.sql))).toBe(true);
  });

  it('renames a speaker without discarding valid generated audio or export', async () => {
    const { db, calls } = statefulDb();
    const repo = new SpeakerRepository(db);
    const updated = await repo.update('p1', 'speaker-1', 'dev-user', { displayName: 'Nữ chính' });

    expect(updated).toMatchObject({ displayName: 'Nữ chính' });
    expect(calls.some((call) => /UPDATE segments/i.test(call.sql))).toBe(false);
    expect(calls.some((call) => /UPDATE projects/i.test(call.sql))).toBe(false);
  });
});
