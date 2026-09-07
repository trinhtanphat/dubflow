import { useEffect, useState } from 'react';
import { ProjectDashboard } from '../features/projects/ProjectDashboard';
import type { CloudJob } from '../features/projects/jobApi';
import type { CloudProject } from '../features/projects/projectApi';
import { getUsageSummary, type UsageSummaryResponse } from '../features/projects/usageApi';
import { cancelDashboardJob, retryDashboardJob, type DashboardJobResult } from './dashboardJobControl';
import { DASHBOARD_PATH, parseAppRoute, projectPath, type AppRoute } from './appRoute';
import { StudioShell } from './StudioShell';
import {
  createDashboardProject,
  loadProjectDashboardSnapshot,
  openDashboardProject,
} from './projectDashboardFlow';
import { useStudioState } from './useStudioState';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function initialAppRoute(): AppRoute {
  if (typeof window === 'undefined') return { view: 'dashboard' };
  return parseAppRoute(window.location.pathname);
}

function appRoutePath(route: AppRoute): string {
  return route.view === 'studio' ? projectPath(route.projectId) : DASHBOARD_PATH;
}

export function App() {
  const studio = useStudioState();
  const [route, setRoute] = useState<AppRoute>(initialAppRoute);
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [jobsByProject, setJobsByProject] = useState<Record<string, CloudJob[]>>({});
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState('');
  const [usageSummary, setUsageSummary] = useState<UsageSummaryResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState('');
  const hasUnresolvedDrafts = Object.keys(studio.state.drafts).length > 0;

  function navigateTo(nextRoute: AppRoute, mode: 'push' | 'replace' = 'push') {
    setRoute(nextRoute);
    if (typeof window === 'undefined') return;
    const path = appRoutePath(nextRoute);
    if (window.location.pathname === path) return;
    if (mode === 'replace') {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const initialRoute = parseAppRoute(window.location.pathname);
    const canonicalPath = appRoutePath(initialRoute);
    if (window.location.pathname !== canonicalPath) {
      window.history.replaceState(null, '', canonicalPath);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePopState = () => {
      const nextRoute = parseAppRoute(window.location.pathname);
      if (
        hasUnresolvedDrafts
        && route.view === 'studio'
        && appRoutePath(nextRoute) !== appRoutePath(route)
      ) {
        window.history.pushState(null, '', appRoutePath(route));
        return;
      }
      setRoute(nextRoute);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [hasUnresolvedDrafts, route]);

  useEffect(() => {
    if (typeof window === 'undefined' || !hasUnresolvedDrafts || route.view !== 'studio') return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnresolvedDrafts, route.view]);

  useEffect(() => {
    if (route.view !== 'studio' || studio.state.project.id === route.projectId) return;
    let active = true;
    setDashboardError('');
    void openDashboardProject(route.projectId)
      .then((project) => {
        if (!active) return;
        studio.dispatch({ type: 'hydrateProject', project });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDashboardError(errorMessage(error, 'Không thể mở dự án từ đường dẫn.'));
        setRoute({ view: 'dashboard' });
        if (typeof window !== 'undefined') {
          window.history.replaceState(null, '', DASHBOARD_PATH);
        }
      });
    return () => { active = false; };
  }, [route, studio.dispatch, studio.state.project.id]);

  useEffect(() => {
    if (route.view !== 'dashboard') return;
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
  }, [route.view]);

  useEffect(() => {
    if (route.view !== 'dashboard') return;
    let active = true;
    setUsageLoading(true);
    setUsageError('');
    void getUsageSummary()
      .then((summary) => {
        if (active) setUsageSummary(summary);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setUsageError(errorMessage(error, 'Không thể tải mức sử dụng.'));
      })
      .finally(() => {
        if (active) setUsageLoading(false);
      });
    return () => { active = false; };
  }, [route.view]);

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
      navigateTo({ view: 'studio', projectId: project.id });
    } catch (error) {
      setDashboardError(errorMessage(error, 'Không thể mở dự án.'));
    }
  }

  async function handleCreateProject() {
    setDashboardError('');
    try {
      const project = await createDashboardProject('Dự án mới');
      studio.dispatch({ type: 'hydrateProject', project });
      navigateTo({ view: 'studio', projectId: project.id });
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

  if (route.view === 'studio') {
    if (studio.state.project.id !== route.projectId) {
      return (
        <div className="app-studio-view" aria-live="polite">
          <div className="project-dashboard-loading">Đang tải dự án…</div>
        </div>
      );
    }

    return (
      <div className="app-studio-view">
        <button
          type="button"
          className="studio-dashboard-nav"
          disabled={hasUnresolvedDrafts}
          title={hasUnresolvedDrafts ? 'Lưu hoặc xử lý xung đột trước khi quay về danh sách dự án.' : 'Quay về danh sách dự án'}
          onClick={() => navigateTo({ view: 'dashboard' })}
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
      usageSummary={usageSummary}
      usageLoading={usageLoading}
      usageError={usageError}
      onOpenProject={(projectId) => { void handleOpenProject(projectId); }}
      onRetryJob={(projectId, jobId) => { void handleRetryJob(projectId, jobId); }}
      onCancelJob={(projectId, jobId) => { void handleCancelJob(projectId, jobId); }}
      onCreateProject={() => { void handleCreateProject(); }}
    />
  );
}
