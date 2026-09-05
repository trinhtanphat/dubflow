import type { ProjectStore } from '../db/projects';
import type { MediaProcessor } from './media/types';

export class ProcessServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProcessServiceError';
  }
}

export class ProcessService {
  constructor(private readonly projects: ProjectStore, private readonly media?: MediaProcessor) {}

  async start(projectId: string, userId: string) {
    const project = await this.projects.getByIdForUser(projectId, userId);
    if (!project) throw new ProcessServiceError('PROJECT_NOT_FOUND', 'Project not found.');
    if (!project.sourceObjectKey) throw new ProcessServiceError('SOURCE_MEDIA_REQUIRED', 'Upload source media before processing.');
    if (!this.media) {
      return { status: 'blocked', code: 'MEDIA_PROCESSOR_UNAVAILABLE', message: 'FFmpeg media processor is not configured yet.' } as const;
    }
    const metadata = await this.media.probe(project.sourceObjectKey);
    return { status: 'queued', code: 'PROCESS_READY', durationMs: metadata.durationMs } as const;
  }
}
