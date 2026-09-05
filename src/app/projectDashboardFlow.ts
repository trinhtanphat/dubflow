import { listProjectJobs, type CloudJob } from '../features/projects/jobApi';
import { listProjects, type CloudProject } from '../features/projects/projectApi';
import { loadCloudStudioProject } from './cloudHydration';
import type { StudioProject } from '../features/timeline/types';

export type ProjectDashboardSnapshot = {
  projects: CloudProject[];
  jobsByProject: Record<string, CloudJob[]>;
};

export type ProjectDashboardFlowDeps = {
  listProjects: () => Promise<CloudProject[]>;
  listProjectJobs: (projectId: string) => Promise<CloudJob[]>;
};

const defaultDashboardDeps: ProjectDashboardFlowDeps = { listProjects, listProjectJobs };

export async function loadProjectDashboardSnapshot(
  deps: ProjectDashboardFlowDeps = defaultDashboardDeps,
): Promise<ProjectDashboardSnapshot> {
  const projects = await deps.listProjects();
  if (projects.length === 0) return { projects: [], jobsByProject: {} };

  const entries = await Promise.all(projects.map(async (project) => [
    project.id,
    await deps.listProjectJobs(project.id),
  ] as const));
  return { projects, jobsByProject: Object.fromEntries(entries) };
}

export type OpenDashboardProjectDeps = {
  loadCloudStudioProject: (projectId: string) => Promise<StudioProject>;
};

const defaultOpenDeps: OpenDashboardProjectDeps = { loadCloudStudioProject };

export function openDashboardProject(
  projectId: string,
  deps: OpenDashboardProjectDeps = defaultOpenDeps,
): Promise<StudioProject> {
  return deps.loadCloudStudioProject(projectId);
}
