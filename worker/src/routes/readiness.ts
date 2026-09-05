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
};

export async function checkReadiness(db: ReadinessDatabaseLike): Promise<ReadinessResult> {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects' LIMIT 1")
      .first<{ name: string }>();

    if (!row || row.name !== 'projects') {
      return { ready: false, service: 'dubflow', database: 'missing-schema' };
    }

    return { ready: true, service: 'dubflow', database: 'ready' };
  } catch {
    return { ready: false, service: 'dubflow', database: 'unavailable' };
  }
}
