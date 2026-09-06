import type { D1DatabaseLike } from './projects';

export type ExportShareStatus = 'active' | 'expired' | 'revoked';

export type ExportShare = {
  id: string;
  projectId: string;
  exportId?: string | null;
  tokenHint: string;
  exportObjectKey: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  status: ExportShareStatus;
};

export type CreateExportShareInput = {
  projectId: string;
  userId: string;
  exportId?: string | null;
  tokenHash: string;
  tokenHint: string;
  exportObjectKey: string;
  expiresAt: string;
};

export interface ShareStore {
  create(input: CreateExportShareInput): Promise<ExportShare>;
  listForProject(projectId: string, userId: string, now?: Date): Promise<ExportShare[]>;
  revoke(projectId: string, shareId: string, userId: string, now?: Date): Promise<ExportShare | null>;
  resolveActive(shareId: string, tokenHash: string, now?: Date): Promise<ExportShare | null>;
}

type ShareRow = {
  id: string;
  project_id: string;
  export_id: string | null;
  created_by_user_id: string;
  token_hash: string;
  token_hint: string;
  export_object_key: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
};

const SHARE_COLUMNS = `id, project_id, export_id, created_by_user_id, token_hash, token_hint, export_object_key, expires_at, revoked_at, created_at`;

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  return trimmed;
}

function optionalNonEmpty(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null) return null;
  return nonEmpty(value, label);
}

function isoDate(value: string, label: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date.`);
  return date.toISOString();
}

function statusFor(row: ShareRow, now: Date): ExportShareStatus {
  if (row.revoked_at) return 'revoked';
  const expires = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expires)) throw new Error('Persisted share expiry is invalid.');
  return expires <= now.getTime() ? 'expired' : 'active';
}

function fromRow(row: ShareRow, now: Date): ExportShare {
  return {
    id: row.id,
    projectId: row.project_id,
    exportId: row.export_id,
    tokenHint: row.token_hint,
    exportObjectKey: row.export_object_key,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    status: statusFor(row, now),
  };
}

export class ShareRepository implements ShareStore {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async create(input: CreateExportShareInput): Promise<ExportShare> {
    const id = nonEmpty(this.createId(), 'Share id');
    const projectId = nonEmpty(input.projectId, 'Project id');
    const userId = nonEmpty(input.userId, 'User id');
    const exportId = optionalNonEmpty(input.exportId, 'Export id');
    const tokenHash = nonEmpty(input.tokenHash, 'Token hash');
    const tokenHint = nonEmpty(input.tokenHint, 'Token hint');
    const exportObjectKey = nonEmpty(input.exportObjectKey, 'Export object key');
    const expiresAt = isoDate(input.expiresAt, 'Share expiry');

    await this.db.prepare(
      `INSERT INTO export_shares
       (id, project_id, export_id, created_by_user_id, token_hash, token_hint, export_object_key, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, projectId, exportId, userId, tokenHash, tokenHint, exportObjectKey, expiresAt).run();

    const row = await this.db.prepare(
      `SELECT ${SHARE_COLUMNS}
       FROM export_shares
       WHERE id = ? AND project_id = ? AND created_by_user_id = ?
       LIMIT 1`,
    ).bind(id, projectId, userId).first<ShareRow>();
    if (!row) throw new Error('Share was not persisted.');
    return fromRow(row, new Date());
  }

  async listForProject(projectId: string, userId: string, now = new Date()): Promise<ExportShare[]> {
    const project = nonEmpty(projectId, 'Project id');
    const user = nonEmpty(userId, 'User id');
    const result = await this.db.prepare(
      `SELECT ${SHARE_COLUMNS}
       FROM export_shares
       WHERE project_id = ? AND created_by_user_id = ?
       ORDER BY created_at DESC, id DESC`,
    ).bind(project, user).all<ShareRow>();
    return (result.results ?? []).map((row) => fromRow(row, now));
  }

  async resolveActive(shareId: string, tokenHash: string, now = new Date()): Promise<ExportShare | null> {
    const id = nonEmpty(shareId, 'Share id');
    const hash = nonEmpty(tokenHash, 'Token hash');
    const nowIso = now.toISOString();
    const row = await this.db.prepare(
      `SELECT ${SHARE_COLUMNS}
       FROM export_shares
       WHERE id = ?
         AND token_hash = ?
         AND revoked_at IS NULL
         AND expires_at > ?
       LIMIT 1`,
    ).bind(id, hash, nowIso).first<ShareRow>();
    return row ? fromRow(row, now) : null;
  }

  async revoke(projectId: string, shareId: string, userId: string, now = new Date()): Promise<ExportShare | null> {
    const project = nonEmpty(projectId, 'Project id');
    const id = nonEmpty(shareId, 'Share id');
    const user = nonEmpty(userId, 'User id');
    const nowIso = now.toISOString();

    await this.db.prepare(
      `UPDATE export_shares
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND project_id = ? AND created_by_user_id = ?`,
    ).bind(nowIso, id, project, user).run();

    const row = await this.db.prepare(
      `SELECT ${SHARE_COLUMNS}
       FROM export_shares
       WHERE id = ? AND project_id = ? AND created_by_user_id = ?
       LIMIT 1`,
    ).bind(id, project, user).first<ShareRow>();
    return row ? fromRow(row, now) : null;
  }
}
