import { getProject, type CloudProject } from '../features/projects/projectApi';
import { listSegments, type CloudSegment } from '../features/transcript/segmentApi';
import { buildCloudStudioProject } from './cloudStudio';
import type { StudioProject } from '../features/timeline/types';

export type CloudHydrationDeps = {
  getProject: (projectId: string) => Promise<CloudProject>;
  listSegments: (projectId: string) => Promise<CloudSegment[]>;
};

const defaultDeps: CloudHydrationDeps = { getProject, listSegments };

export async function loadCloudStudioProject(
  projectId: string,
  deps: CloudHydrationDeps = defaultDeps,
): Promise<StudioProject> {
  const project = await deps.getProject(projectId);
  const segments = await deps.listSegments(projectId);
  return buildCloudStudioProject(project, segments);
}
