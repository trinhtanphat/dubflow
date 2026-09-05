import { useEffect, useState } from 'react';
import { ProjectDashboard } from '../features/projects/ProjectDashboard';
import type { CloudJob } from '../features/projects/jobApi';
import type { CloudProject } from '../features/projects/projectApi';
import { cancelDashboardJob, retryDashboardJob, type DashboardJobResult } from './dashboardJobControl';
import { StudioShell } from './StudioShell';
import {
  createDashboardProject,
  loadProjectDashboardSnapshot,
  openDashboardProject,
} from './projectDashboardFlow';
import { useStudioState } from './useStudioState';

type AppView = 'dashboard' | 'studio';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function App() {
  const studio = useStudioState();
  const [view, setView] = useState<AppView>('dashboard');
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [jobsByProject, setJobsByProject] = useState<Record<string, CloudJob[]>>({});
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState('');

  useEffect(() => {
    if (view !== 'dashboard') return;
    let active = true;
    setDashboardLoading(true);
    setDashboardError('');
    void loadProjectDashboardSnapshot()
      .then((snapshot) => {
        if (!active) return;
        setProjects(snapshot.projects);
        setJobsByProject(snapshot.jobsByProject);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDashboardError(errorMessage(error, 'Không thể tải danh sách dự án.'));
      })
      .finally(() => {
        if (active) setDashboardLoading(false);
      });
    return () => { active = false; };
  }, [view]);

  function applyJobResult(projectId: string, jobId: string, result: DashboardJobResult) {
    setProjects((current) => current.map((project) => project.id === projectId ? result.project : project));
    setJobsByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).map((job) => job.id === jobId ? result.job : job),
    }));
  }

  async function handleOpenProject(projectId: string) {
    setDashboardError('');
    try {
      const project = await openDashboardProject(projectId);
      studio.dispatch({ type: 'hydrateProject', project });
      setView('studio');
    } catch (error) {
      setDashboardError(errorMessage(error, 'Không thể mở dự án.'));
    }
  }

  async function handleCreateProject() {
    setDashboardError('');
    try {
      const project = await createDashboardProject('Dự án mới');
      studio.dispatch({ type: 'hydrateProject', project });
      setView('studio');
    } catch (error) {
      setDashboardError(errorMessage(error, 'Không thể tạo dự án.'));
    }
  }

  async function handleRetryJob(projectId: string, jobId: string) {
    setDashboardError('');
    try {
      const result = await retryDashboardJob(projectId, jobId);
      applyJobResult(projectId, jobId, result);
    } catch (error) {
      setDashboardError(errorMessage(error, 'Không thể thử lại job.'));
    }
  }

  async function handleCancelJob(projectId: string, jobId: string) {
    setDashboardError('');
    try {
      const result = await cancelDashboardJob(projectId, jobId);
      applyJobResult(projectId, jobId, result);
    } catch (error) {
      setDashboardError(errorMessage(error, 'Không thể hủy job.'));
    }
  }

  const hasUnresolvedDrafts = Object.keys(studio.state.drafts).length > 0;

  if (view === 'studio') {
    return (
      <div className="app-studio-view">
        <button
          type="button"
          className="studio-dashboard-nav"
          disabled={hasUnresolvedDrafts}
          title={hasUnresolvedDrafts ? 'Lưu hoặc xử lý xung đột trước khi quay về danh sách dự án.' : 'Quay về danh sách dự án'}
          onClick={() => setView('dashboard')}
        >
          ← Dự án
        </button>
        <StudioShell {...studio} />
      </div>
    );
  }

  return (
    <ProjectDashboard
      projects={projects}
      jobsByProject={jobsByProject}
      loading={dashboardLoading}
      error={dashboardError}
      onOpenProject={(projectId) => { void handleOpenProject(projectId); }}
      onRetryJob={(projectId, jobId) => { void handleRetryJob(projectId, jobId); }}
      onCancelJob={(projectId, jobId) => { void handleCancelJob(projectId, jobId); }}
      onCreateProject={() => { void handleCreateProject(); }}
    />
  );
}
