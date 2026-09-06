import type { D1DatabaseLike } from './projects';

export type VoiceCloneStatus =
  | 'creating'
  | 'verification_required'
  | 'ready'
  | 'failed'
  | 'deleting'
  | 'deleted';

export type VoiceClone = {
  id: string;
  userId: string;
  projectId: string;
  provider: 'elevenlabs';
  providerVoiceId: string | null;
  name: string;
  status: VoiceCloneStatus;
  consentVersion: string;
  consentedAt: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface VoiceCloneStore {
  create(projectId: string, userId: string, name: string, consentVersion: string): Promise<VoiceClone>;
  list(projectId: string, userId: string): Promise<VoiceClone[]>;
  get(projectId: string, cloneId: string, userId: string): Promise<VoiceClone | null>;
  markProviderResult(projectId: string, cloneId: string, userId: string, providerVoiceId: string, requiresVerification: boolean): Promise<VoiceClone>;
  markFailed(projectId: string, cloneId: string, userId: string, errorCode: string): Promise<VoiceClone>;
  markDeleting(projectId: string, cloneId: string, userId: string): Promise<VoiceClone>;
  markDeleted(projectId: string, cloneId: string, userId: string): Promise<VoiceClone>;
}

type VoiceCloneRow = {
  id: string;
  user_id: string;
  project_id: string;
  provider: 'elevenlabs';
  provider_voice_id: string | null;
  name: string;
  status: VoiceCloneStatus;
  consent_version: string;
  consented_at: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = `vc.id, vc.user_id, vc.project_id, vc.provider, vc.provider_voice_id, vc.name,
  vc.status, vc.consent_version, vc.consented_at, vc.error_code, vc.created_at, vc.updated_at`;

function fromRow(row: VoiceCloneRow): VoiceClone {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    provider: row.provider,
    providerVoiceId: row.provider_voice_id,
    name: row.name,
    status: row.status,
    consentVersion: row.consent_version,
    consentedAt: row.consented_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class VoiceClonePersistenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'VoiceClonePersistenceError';
  }
}

export class VoiceCloneRepository implements VoiceCloneStore {
  constructor(private readonly db: D1DatabaseLike) {}

  private async assertProjectOwned(projectId: string, userId: string): Promise<void> {
    const row = await this.db.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<{ id: string }>();
    if (!row) throw new VoiceClonePersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
  }

  async create(projectId: string, userId: string, name: string, consentVersion: string): Promise<VoiceClone> {
    await this.assertProjectOwned(projectId, userId);
    const id = crypto.randomUUID();
    await this.db.prepare(
      `INSERT INTO voice_clones (id, user_id, project_id, provider, name, status, consent_version, consented_at)
       VALUES (?, ?, ?, 'elevenlabs', ?, 'creating', ?, datetime('now'))`,
    ).bind(id, userId, projectId, name, consentVersion).run();
    const created = await this.get(projectId, id, userId);
    if (!created) throw new VoiceClonePersistenceError('VOICE_CLONE_CREATE_FAILED', 'Voice clone could not be created.');
    return created;
  }

  async list(projectId: string, userId: string): Promise<VoiceClone[]> {
    const result = await this.db.prepare(
      `SELECT ${COLUMNS} FROM voice_clones vc
       JOIN projects p ON p.id = vc.project_id
       WHERE vc.project_id = ? AND vc.user_id = ? AND p.user_id = ?
       ORDER BY vc.created_at DESC, vc.id DESC`,
    ).bind(projectId, userId, userId).all<VoiceCloneRow>();
    return (result.results ?? []).map(fromRow);
  }

  async get(projectId: string, cloneId: string, userId: string): Promise<VoiceClone | null> {
    const row = await this.db.prepare(
      `SELECT ${COLUMNS} FROM voice_clones vc
       JOIN projects p ON p.id = vc.project_id
       WHERE vc.project_id = ? AND vc.id = ? AND vc.user_id = ? AND p.user_id = ? LIMIT 1`,
    ).bind(projectId, cloneId, userId, userId).first<VoiceCloneRow>();
    return row ? fromRow(row) : null;
  }

  private async update(
    projectId: string,
    cloneId: string,
    userId: string,
    status: VoiceCloneStatus,
    providerVoiceId: string | null | undefined,
    errorCode: string | null,
  ): Promise<VoiceClone> {
    const existing = await this.get(projectId, cloneId, userId);
    if (!existing) throw new VoiceClonePersistenceError('VOICE_CLONE_NOT_FOUND', 'Voice clone not found.');
    const voiceId = providerVoiceId === undefined ? existing.providerVoiceId : providerVoiceId;
    await this.db.prepare(
      `UPDATE voice_clones
       SET status = ?, provider_voice_id = ?, error_code = ?, updated_at = datetime('now')
       WHERE id = ? AND project_id = ? AND user_id = ?`,
    ).bind(status, voiceId, errorCode, cloneId, projectId, userId).run();
    const updated = await this.get(projectId, cloneId, userId);
    if (!updated) throw new VoiceClonePersistenceError('VOICE_CLONE_NOT_FOUND', 'Voice clone not found.');
    return updated;
  }

  markProviderResult(projectId: string, cloneId: string, userId: string, providerVoiceId: string, requiresVerification: boolean): Promise<VoiceClone> {
    return this.update(
      projectId,
      cloneId,
      userId,
      requiresVerification ? 'verification_required' : 'ready',
      providerVoiceId,
      requiresVerification ? 'VOICE_CLONE_VERIFICATION_REQUIRED' : null,
    );
  }

  markFailed(projectId: string, cloneId: string, userId: string, errorCode: string): Promise<VoiceClone> {
    return this.update(projectId, cloneId, userId, 'failed', undefined, errorCode);
  }

  markDeleting(projectId: string, cloneId: string, userId: string): Promise<VoiceClone> {
    return this.update(projectId, cloneId, userId, 'deleting', undefined, null);
  }

  markDeleted(projectId: string, cloneId: string, userId: string): Promise<VoiceClone> {
    return this.update(projectId, cloneId, userId, 'deleted', undefined, null);
  }
}
