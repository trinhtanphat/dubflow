import type { D1DatabaseLike } from './projects';

export type ProviderMediaGrant = {
  id: string;
  projectId: string;
  objectKey: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type CreateProviderMediaGrantInput = {
  projectId: string;
  userId: string;
  objectKey: string;
  tokenHash: string;
  expiresAt: string;
};

type ProviderMediaGrantRow = {
  id: string;
  project_id: string;
  object_key: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

const GRANT_COLUMNS = 'id, project_id, object_key, token_hash, expires_at, consumed_at, created_at';

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  return trimmed;
}

function isoDate(value: string, label: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date.`);
  return date.toISOString();
}

function projectObjectKey(projectId: string, objectKey: string): string {
  const key = nonEmpty(objectKey, 'Provider media object key');
  const prefix = `projects/${projectId}/`;
  if (
    !key.startsWith(prefix)
    || key.length <= prefix.length
    || key.includes('..')
    || key.includes('\\')
    || key.includes('?')
    || key.includes('#')
  ) {
    throw new Error('Provider media object key must be an exact project-scoped R2 key.');
  }
  return key;
}

function tokenHash(value: string): string {
  const hash = nonEmpty(value, 'Provider media token hash').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Provider media token hash must be a SHA-256 hex digest.');
  return hash;
}

function fromRow(row: ProviderMediaGrantRow): ProviderMediaGrant {
  return {
    id: row.id,
    projectId: row.project_id,
    objectKey: row.object_key,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export class ProviderMediaGrantRepository {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly makeId: () => string = () => crypto.randomUUID(),
  ) {}

  private async assertProject(projectId: string, userId: string): Promise<void> {
    const project = await this.db.prepare(
      'SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1',
    ).bind(projectId, userId).first<{ id: string }>();
    if (!project) throw new Error('Project not found.');
  }

  async create(input: CreateProviderMediaGrantInput): Promise<ProviderMediaGrant> {
    const projectId = nonEmpty(input.projectId, 'Project id');
    const userId = nonEmpty(input.userId, 'User id');
    await this.assertProject(projectId, userId);

    const id = nonEmpty(this.makeId(), 'Provider media grant id');
    const objectKey = projectObjectKey(projectId, input.objectKey);
    const hash = tokenHash(input.tokenHash);
    const expiresAt = isoDate(input.expiresAt, 'Provider media grant expiry');

    await this.db.prepare(
      `INSERT INTO provider_media_grants (id, project_id, object_key, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, projectId, objectKey, hash, expiresAt).run();

    const row = await this.db.prepare(
      `SELECT ${GRANT_COLUMNS}
       FROM provider_media_grants
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
    ).bind(id, projectId).first<ProviderMediaGrantRow>();
    if (!row) throw new Error('Provider media grant was not persisted.');
    return fromRow(row);
  }

  async resolveActive(grantId: string, hash: string, now = new Date()): Promise<ProviderMediaGrant | null> {
    const id = nonEmpty(grantId, 'Provider media grant id');
    const normalizedHash = tokenHash(hash);
    const nowIso = now.toISOString();
    const row = await this.db.prepare(
      `SELECT ${GRANT_COLUMNS}
       FROM provider_media_grants
       WHERE id = ? AND token_hash = ? AND expires_at > ?
       LIMIT 1`,
    ).bind(id, normalizedHash, nowIso).first<ProviderMediaGrantRow>();
    return row ? fromRow(row) : null;
  }

  async markAccessed(grantId: string, now = new Date()): Promise<void> {
    const id = nonEmpty(grantId, 'Provider media grant id');
    await this.db.prepare(
      `UPDATE provider_media_grants
       SET consumed_at = COALESCE(consumed_at, ?)
       WHERE id = ?`,
    ).bind(now.toISOString(), id).run();
  }

  async expire(grantId: string, now = new Date()): Promise<void> {
    const id = nonEmpty(grantId, 'Provider media grant id');
    await this.db.prepare(
      `UPDATE provider_media_grants
       SET expires_at = ?
       WHERE id = ? AND expires_at > ?`,
    ).bind(now.toISOString(), id, now.toISOString()).run();
  }
}
