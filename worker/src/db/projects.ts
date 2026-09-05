import type { ProjectRow, SourceLanguage } from '../domain/project';

export class ProjectRepository {
  constructor(private readonly db: D1Database) {}

  async create(userId: string, title: string, sourceLanguage: SourceLanguage): Promise<ProjectRow> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.prepare(`INSERT INTO projects (id,user_id,title,source_language,target_language,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, userId, title, sourceLanguage, 'vi', 'draft', now, now)
      .run();
    const row = await this.getByIdForUser(id, userId);
    if (!row) throw new Error('Project insert did not return a row');
    return row;
  }

  async listByUser(userId: string): Promise<ProjectRow[]> {
    const result = await this.db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC').bind(userId).all<ProjectRow>();
    return result.results;
  }

  async getByIdForUser(id: string, userId: string): Promise<ProjectRow | null> {
    return this.db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ? LIMIT 1').bind(id, userId).first<ProjectRow>();
  }
}
