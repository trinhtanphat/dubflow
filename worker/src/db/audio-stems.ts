import type { D1DatabaseLike } from './projects';

export type AudioStemKind = 'background' | 'dialogue';
export type AudioStemStatus = 'pending' | 'completed' | 'failed' | 'invalidated';

export type AudioStem = {
  id: string;
  projectId: string;
  sourceGeneration: number;
  kind: AudioStemKind;
  provider: string;
  providerVersion: string | null;
  status: AudioStemStatus;
  objectKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type AudioStemRow = {
  id: string;
  project_id: string;
  source_generation: number;
  kind: AudioStemKind;
  provider: string;
  provider_version: string | null;
  status: AudioStemStatus;
  object_key: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = `s.id, s.project_id, s.source_generation, s.kind, s.provider, s.provider_version,
  s.status, s.object_key, s.error_code, s.error_message, s.created_at, s.updated_at`;

function fromRow(row: AudioStemRow): AudioStem {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceGeneration: Number(row.source_generation),
    kind: row.kind,
    provider: row.provider,
    providerVersion: row.provider_version,
    status: row.status,
    objectKey: row.object_key,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AudioStemPersistenceError extends Error {
  constructor(public readonly code: 'PROJECT_NOT_FOUND' | 'AUDIO_STEM_NOT_FOUND', message: string) {
    super(message);
    this.name = 'AudioStemPersistenceError';
  }
}

export class AudioStemRepository {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly makeId: () => string = () => crypto.randomUUID(),
  ) {}

  private async assertProjectOwned(projectId: string, userId: string): Promise<void> {
    const project = await this.db.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<{ id: string }>();
    if (!project) throw new AudioStemPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
  }

  private async getOwned(projectId: string, stemId: string, userId: string): Promise<AudioStem | null> {
    const row = await this.db.prepare(
      `SELECT ${COLUMNS}
       FROM project_audio_stems s
       JOIN projects p ON p.id = s.project_id
       WHERE s.project_id = ? AND s.id = ? AND p.user_id = ?
       LIMIT 1`,
    ).bind(projectId, stemId, userId).first<AudioStemRow>();
    return row ? fromRow(row) : null;
  }

  async latestCompleted(
    projectId: string,
    userId: string,
    sourceGeneration: number,
    kind: AudioStemKind,
    provider: string,
  ): Promise<AudioStem | null> {
    const row = await this.db.prepare(
      `SELECT ${COLUMNS}
       FROM project_audio_stems s
       JOIN projects p ON p.id = s.project_id
       WHERE s.project_id = ? AND s.source_generation = ? AND s.kind = ? AND s.provider = ?
         AND s.status = 'completed' AND p.user_id = ?
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT 1`,
    ).bind(projectId, sourceGeneration, kind, provider, userId).first<AudioStemRow>();
    return row ? fromRow(row) : null;
  }

  async begin(
    projectId: string,
    userId: string,
    sourceGeneration: number,
    kind: AudioStemKind,
    provider: string,
    providerVersion: string | null = null,
  ): Promise<AudioStem> {
    await this.assertProjectOwned(projectId, userId);
    const active = await this.db.prepare(
      `SELECT ${COLUMNS}
       FROM project_audio_stems s
       WHERE s.project_id = ? AND s.source_generation = ? AND s.kind = ? AND s.provider = ?
         AND s.status IN ('pending','completed')
       ORDER BY CASE s.status WHEN 'completed' THEN 0 ELSE 1 END, s.created_at DESC, s.id DESC
       LIMIT 1`,
    ).bind(projectId, sourceGeneration, kind, provider).first<AudioStemRow>();
    if (active) return fromRow(active);

    const id = this.makeId();
    await this.db.prepare(
      `INSERT INTO project_audio_stems
        (id, project_id, source_generation, kind, provider, provider_version, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).bind(id, projectId, sourceGeneration, kind, provider, providerVersion).run();
    const now = new Date(0).toISOString();
    return {
      id,
      projectId,
      sourceGeneration,
      kind,
      provider,
      providerVersion,
      status: 'pending',
      objectKey: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async complete(
    projectId: string,
    stemId: string,
    userId: string,
    objectKey: string,
    providerVersion: string | null = null,
  ): Promise<void> {
    const stem = await this.getOwned(projectId, stemId, userId);
    if (!stem) throw new AudioStemPersistenceError('AUDIO_STEM_NOT_FOUND', 'Audio stem not found.');
    const prefix = `projects/${projectId}/stems/${stem.sourceGeneration}/${stem.provider}/`;
    if (!objectKey.startsWith(prefix)) {
      throw new Error('Audio stem object key is outside the canonical project/source/provider prefix.');
    }
    await this.db.prepare(
      `UPDATE project_audio_stems
       SET status = 'completed', object_key = ?, provider_version = ?,
           error_code = NULL, error_message = NULL, updated_at = datetime('now')
       WHERE id = ? AND project_id = ?`,
    ).bind(objectKey, providerVersion ?? stem.providerVersion, stemId, projectId).run();
  }

  async fail(projectId: string, stemId: string, userId: string, code: string, message: string): Promise<void> {
    const stem = await this.getOwned(projectId, stemId, userId);
    if (!stem) throw new AudioStemPersistenceError('AUDIO_STEM_NOT_FOUND', 'Audio stem not found.');
    await this.db.prepare(
      `UPDATE project_audio_stems
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = datetime('now')
       WHERE id = ? AND project_id = ? AND status != 'completed'`,
    ).bind(code, message, stemId, projectId).run();
  }
}
