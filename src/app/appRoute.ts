export type AppRoute =
  | { view: 'dashboard' }
  | { view: 'studio'; projectId: string };

export const DASHBOARD_PATH = '/projects';

export function projectPath(projectId: string): string {
  if (!projectId.trim()) return DASHBOARD_PATH;
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function parseAppRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === DASHBOARD_PATH || pathname === `${DASHBOARD_PATH}/`) {
    return { view: 'dashboard' };
  }

  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  if (!match) return { view: 'dashboard' };

  try {
    const projectId = decodeURIComponent(match[1]);
    return projectId ? { view: 'studio', projectId } : { view: 'dashboard' };
  } catch {
    return { view: 'dashboard' };
  }
}
