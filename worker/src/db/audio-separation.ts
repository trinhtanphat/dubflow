import type { D1DatabaseLike, D1RunResultLike } from './projects';

export type AudioSeparationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'invalidated';

export type AudioSeparation = {
  id: string;
  projectId: string;
  sourceRevision: number;
  provider: string;
  modelId: string;
  modelDigest: string;
  status: AudioSeparationStatus;
  backgroundObjectKey: string | null;
  dialogueObjectKey: string | null;
  jobId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

type AudioSeparationRow = {
  id: string;
  project_id: string;
  source_revision: number;
  provider: string;
  model_id: string;
  model_digest: string;
  status: AudioSeparationStatus;
  background_object_key: string | null;
  dialogue_object_key: string | null;
  job_id: string | null;
  error_code: string | null;
  error_message: string | null;
};

export class AudioSeparationPersistenceError extends Error {
  constructor(public readonly code: 'PROJECT_NOT_FOUND' | 'SEPARATION_NOT_FOUND' | 'SEPARATION_ARTIFACT_INVALID', message: string) {
    super(message);
    this.name = 'AudioSeparationPersistenceError';
  }
}

function fromRow(row: AudioSeparationRow): AudioSeparation {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceRevision: row.source_revision,
    provider: row.provider,
    modelId: row.model_id,
    modelDigest: row.model_digest,
    status: row.status,
    backgroundObjectKey: row.background_object_key,
    dialogueObjectKey: row.dialogue_object_key,
    jobId: row.job_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function validIdentityPart(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,200}$/.test(value);
}

export function separationObjectPrefix(
  projectId: string,
  sourceRevision: number,
  provider: string,
  modelDigest: string,
): string {
  if (!validIdentityPart(projectId) || !Number.isInteger(sourceRevision) || sourceRevision < 1
    || !validIdentityPart(provider) || !validIdentityPart(modelDigest)) {
    throw new AudioSeparationPersistenceError('SEPARATION_ARTIFACT_INVALID', 'Separation identity is invalid.');
  }
  return `projects/${projectId}/stems/${sourceRevision}/${provider}/${modelDigest}/`;
}

function affectedRows(result: D1RunResultLike): number {
  const value = result.meta?.changes ?? result.changes ?? 0;
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

export class AudioSeparationRepository {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly makeId: () => string = () => crypto.randomUUID(),
  ) {}

  private async assertProject(projectId: string, userId: string): Promise<void> {
    const project = await this.db.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<{ id: string }>();
    if (!project) throw new AudioSeparationPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
  }

  async getCurrent(
    projectId: string,
    userId: string,
    sourceRevision: number,
    provider: string,
    modelDigest: string,
  ): Promise<AudioSeparation | null> {
    const row = await this.db.prepare(
      `SELECT s.id, s.project_id, s.source_revision, s.provider, s.model_id, s.model_digest, s.status,
              s.background_object_key, s.dialogue_object_key, s.job_id, s.error_code, s.error_message
       FROM audio_separations s
       JOIN projects p ON p.id = s.project_id
       WHERE s.project_id = ? AND p.user_id = ? AND s.source_revision = ?
         AND s.provider = ? AND s.model_digest = ?
       LIMIT 1`,
    ).bind(projectId, userId, sourceRevision, provider, modelDigest).first<AudioSeparationRow>();
    return row ? fromRow(row) : null;
  }

  async createPending(input: {
    projectId: string;
    userId: string;
    sourceRevision: number;
    provider: string;
    modelId: string;
    modelDigest: string;
    jobId?: string | null;
  }): Promise<AudioSeparation> {
    await this.assertProject(input.projectId, input.userId);
    separationObjectPrefix(input.projectId, input.sourceRevision, input.provider, input.modelDigest);
    if (!validIdentityPart(input.modelId)) {
      throw new AudioSeparationPersistenceError('SEPARATION_ARTIFACT_INVALID', 'Separation model id is invalid.');
    }
    const id = this.makeId();
    await this.db.prepare(
      `INSERT INTO audio_separations
       (id, project_id, source_revision, provider, model_id, model_digest, status, job_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(id, input.projectId, input.sourceRevision, input.provider, input.modelId, input.modelDigest, input.jobId ?? null).run();
    return {
      id,
      projectId: input.projectId,
      sourceRevision: input.sourceRevision,
      provider: input.provider,
      modelId: input.modelId,
      modelDigest: input.modelDigest,
      status: 'pending',
      backgroundObjectKey: null,
      dialogueObjectKey: null,
      jobId: input.jobId ?? null,
      errorCode: null,
      errorMessage: null,
    };
  }

  async markRunning(projectId: string, separationId: string, userId: string): Promise<void> {
    await this.assertProject(projectId, userId);
    const result = await this.db.prepare(
      `UPDATE audio_separations SET status = 'running', error_code = NULL, error_message = NULL,
              updated_at = datetime('now') WHERE id = ? AND project_id = ?`,
    ).bind(separationId, projectId).run();
    if (affectedRows(result) === 0) throw new AudioSeparationPersistenceError('SEPARATION_NOT_FOUND', 'Separation not found.');
  }

  async complete(
    projectId: string,
    separationId: string,
    userId: string,
    identity: { sourceRevision: number; provider: string; modelDigest: string },
    keys: { backgroundObjectKey: string; dialogueObjectKey: string },
  ): Promise<void> {
    await this.assertProject(projectId, userId);
    const prefix = separationObjectPrefix(projectId, identity.sourceRevision, identity.provider, identity.modelDigest);
    if (keys.backgroundObjectKey !== `${prefix}background.wav` || keys.dialogueObjectKey !== `${prefix}dialogue.wav`) {
      throw new AudioSeparationPersistenceError('SEPARATION_ARTIFACT_INVALID', 'Separation artifacts do not match the canonical identity.');
    }
    const result = await this.db.prepare(
      `UPDATE audio_separations
       SET status = 'completed', background_object_key = ?, dialogue_object_key = ?,
           error_code = NULL, error_message = NULL, updated_at = datetime('now')
       WHERE id = ? AND project_id = ? AND source_revision = ? AND provider = ? AND model_digest = ?`,
    ).bind(keys.backgroundObjectKey, keys.dialogueObjectKey, separationId, projectId,
      identity.sourceRevision, identity.provider, identity.modelDigest).run();
    if (affectedRows(result) === 0) throw new AudioSeparationPersistenceError('SEPARATION_NOT_FOUND', 'Separation not found.');
  }

  async fail(projectId: string, separationId: string, userId: string, code: string, message: string): Promise<void> {
    await this.assertProject(projectId, userId);
    const result = await this.db.prepare(
      `UPDATE audio_separations
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = datetime('now')
       WHERE id = ? AND project_id = ?`,
    ).bind(code, message, separationId, projectId).run();
    if (affectedRows(result) === 0) throw new AudioSeparationPersistenceError('SEPARATION_NOT_FOUND', 'Separation not found.');
  }
}
