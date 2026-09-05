import type { StudioProject } from '../timeline/types';

export function mediaUrlForProject(project: Pick<StudioProject, 'id' | 'sourceObjectKey'>): string | null {
  return project.sourceObjectKey ? `/api/projects/${encodeURIComponent(project.id)}/media` : null;
}

export function frameStepMs(frameRate?: number | null): number {
  const fps = Number.isFinite(frameRate) && (frameRate ?? 0) > 0 ? Number(frameRate) : 30;
  return 1000 / fps;
}
