import { asrCapabilities, type AsrCapabilities } from '../services/asr/router';

export interface ReadinessStatementLike {
  first<T>(): Promise<T | null>;
}

export interface ReadinessDatabaseLike {
  prepare(sql: string): ReadinessStatementLike;
}

export type ReadinessResult = {
  ready: boolean;
  service: 'dubflow';
  database: 'ready' | 'missing-schema' | 'unavailable';
  asr: AsrCapabilities;
};

export async function checkReadiness(db: ReadinessDatabaseLike, deepgramApiKey?: string): Promise<ReadinessResult> {
  const asr = asrCapabilities(deepgramApiKey);
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects' LIMIT 1")
      .first<{ name: string }>();

    if (!row || row.name !== 'projects') {
      return { ready: false, service: 'dubflow', database: 'missing-schema', asr };
    }

    return { ready: true, service: 'dubflow', database: 'ready', asr };
  } catch {
    return { ready: false, service: 'dubflow', database: 'unavailable', asr };
  }
}
