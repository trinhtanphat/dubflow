import { getProject, type CloudProject } from '../features/projects/projectApi';
import { listSpeakers, type CloudSpeaker } from '../features/speakers/speakerApi';
import { listSegments, type CloudSegment } from '../features/transcript/segmentApi';
import { buildCloudStudioProject } from './cloudStudio';
import type { StudioProject } from '../features/timeline/types';

export type CloudHydrationDeps = {
  getProject: (projectId: string) => Promise<CloudProject>;
  listSegments: (projectId: string) => Promise<CloudSegment[]>;
  listSpeakers?: (projectId: string) => Promise<CloudSpeaker[]>;
};

const defaultDeps: CloudHydrationDeps = { getProject, listSegments, listSpeakers };

export async function loadCloudStudioProject(
  projectId: string,
  deps: CloudHydrationDeps = defaultDeps,
): Promise<StudioProject> {
  const project = await deps.getProject(projectId);
  const [segments, speakers] = await Promise.all([
    deps.listSegments(projectId),
    deps.listSpeakers ? deps.listSpeakers(projectId) : Promise.resolve([]),
  ]);
  return buildCloudStudioProject(project, segments, speakers);
}
