import type { MultilangStore } from './multilang';
import type { D1DatabaseLike } from './projects';

export type Speaker = {
  id: string;
  projectId: string;
  label: string;
  displayName: string;
  voiceProvider: string | null;
  voiceId: string | null;
  avatarObjectKey: string | null;
};

export type SpeakerPatch = {
  displayName?: string;
  voiceId?: string | null;
};

export interface SpeakerStore {
  list(projectId: string, userId: string): Promise<Speaker[]>;
  update(projectId: string, speakerId: string, userId: string, patch: SpeakerPatch): Promise<Speaker | null>;
}

type SpeakerRow = {
  id: string;
  project_id: string;
  label: string;
  display_name: string;
  voice_provider: string | null;
  voice_id: string | null;
  avatar_object_key: string | null;
};

type ProjectStateRow = { id: string; status: string };

function fromRow(row: SpeakerRow): Speaker {
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    displayName: row.display_name,
    voiceProvider: row.voice_provider,
    voiceId: row.voice_id,
    avatarObjectKey: row.avatar_object_key,
  };
}

const SELECT = `SELECT s.id, s.project_id, s.label, s.display_name, s.voice_provider, s.voice_id, s.avatar_object_key
  FROM speakers s JOIN projects p ON p.id = s.project_id`;

export class SpeakerPersistenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SpeakerPersistenceError';
  }
}

export class SpeakerRepository implements SpeakerStore {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly multilang?: Pick<MultilangStore, 'invalidateSpeakerAllTargets'>,
  ) {}

  async list(projectId: string, userId: string): Promise<Speaker[]> {
    const result = await this.db.prepare(
      `${SELECT} WHERE s.project_id = ? AND p.user_id = ? ORDER BY s.label, s.id`,
    ).bind(projectId, userId).all<SpeakerRow>();
    return (result.results ?? []).map(fromRow);
  }

  private async get(projectId: string, speakerId: string, userId: string): Promise<Speaker | null> {
    const row = await this.db.prepare(
      `${SELECT} WHERE s.project_id = ? AND s.id = ? AND p.user_id = ? LIMIT 1`,
    ).bind(projectId, speakerId, userId).first<SpeakerRow>();
    return row ? fromRow(row) : null;
  }

  private async assertProjectEditable(projectId: string, userId: string): Promise<void> {
    const project = await this.db.prepare(
      `SELECT id, status FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<ProjectStateRow>();
    if (!project) throw new SpeakerPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    if (project.status === 'processing') {
      throw new SpeakerPersistenceError('PROJECT_BUSY', 'Project is locked while cloud processing or export is active.');
    }
  }

  async update(projectId: string, speakerId: string, userId: string, patch: SpeakerPatch): Promise<Speaker | null> {
    const current = await this.get(projectId, speakerId, userId);
    if (!current) return null;
    await this.assertProjectEditable(projectId, userId);

    const displayName = patch.displayName ?? current.displayName;
    const voiceId = patch.voiceId === undefined ? current.voiceId : patch.voiceId;
    const voiceProvider = patch.voiceId === undefined
      ? current.voiceProvider
      : voiceId ? 'elevenlabs' : null;
    const voiceChanged = voiceId !== current.voiceId || voiceProvider !== current.voiceProvider;

    const updateSpeaker = this.db.prepare(
      `UPDATE speakers SET display_name = ?, voice_provider = ?, voice_id = ?
       WHERE id = ? AND project_id = ? AND EXISTS (
         SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?
       )`,
    ).bind(displayName, voiceProvider, voiceId, speakerId, projectId, userId);

    if (voiceChanged && this.db.batch) {
      await this.db.batch([
        updateSpeaker,
        this.db.prepare(
          `UPDATE segments SET voice_status = 'pending', dubbed_object_key = NULL, version = version + 1
           WHERE project_id = ? AND speaker_id = ?`,
        ).bind(projectId, speakerId),
        this.db.prepare(
          `UPDATE projects SET export_object_key = NULL, status = 'needs_review', updated_at = datetime('now')
           WHERE id = ? AND user_id = ?`,
        ).bind(projectId, userId),
      ]);
    } else {
      await updateSpeaker.run();
      if (voiceChanged) {
        await this.db.prepare(
          `UPDATE segments SET voice_status = 'pending', dubbed_object_key = NULL, version = version + 1
           WHERE project_id = ? AND speaker_id = ?`,
        ).bind(projectId, speakerId).run();
        await this.db.prepare(
          `UPDATE projects SET export_object_key = NULL, status = 'needs_review', updated_at = datetime('now')
           WHERE id = ? AND user_id = ?`,
        ).bind(projectId, userId).run();
      }
    }

    if (voiceChanged) {
      await this.multilang?.invalidateSpeakerAllTargets(projectId, speakerId, userId);
    }

    return {
      ...current,
      displayName,
      voiceProvider,
      voiceId,
    };
  }
}
