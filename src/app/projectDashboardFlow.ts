import { listProjectJobs, type CloudJob } from '../features/projects/jobApi';
import { createProject, listProjects, type CloudProject } from '../features/projects/projectApi';
import type { StudioProject } from '../features/timeline/types';
import { loadCloudStudioProject } from './cloudHydration';

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

export type CreateDashboardProjectDeps = {
  createProject: typeof createProject;
  loadCloudStudioProject: (projectId: string) => Promise<StudioProject>;
};

const defaultCreateDeps: CreateDashboardProjectDeps = { createProject, loadCloudStudioProject };

export async function createDashboardProject(
  title: string,
  deps: CreateDashboardProjectDeps = defaultCreateDeps,
): Promise<StudioProject> {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Error('Tên dự án không được để trống.');
  const created = await deps.createProject(cleanTitle, 'auto');
  return deps.loadCloudStudioProject(created.id);
}
