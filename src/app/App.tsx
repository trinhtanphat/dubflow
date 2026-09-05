import { useEffect, useState } from 'react';
import { ProjectDashboard } from '../features/projects/ProjectDashboard';
import type { CloudJob } from '../features/projects/jobApi';
import type { CloudProject } from '../features/projects/projectApi';
import { StudioShell } from './StudioShell';
import { loadProjectDashboardSnapshot, openDashboardProject } from './projectDashboardFlow';
import { useStudioState } from './useStudioState';

type AppView = 'dashboard' | 'studio';

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
        setDashboardError(error instanceof Error ? error.message : 'Không thể tải danh sách dự án.');
      })
      .finally(() => {
        if (active) setDashboardLoading(false);
      });
    return () => { active = false; };
  }, [view]);

  async function handleOpenProject(projectId: string) {
    setDashboardError('');
    try {
      const project = await openDashboardProject(projectId);
      studio.dispatch({ type: 'hydrateProject', project });
      setView('studio');
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'Không thể mở dự án.');
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
      onRetryJob={() => undefined}
      onCancelJob={() => undefined}
      onCreateProject={() => setView('studio')}
    />
  );
}
