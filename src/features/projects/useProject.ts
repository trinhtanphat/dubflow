import { useEffect, useState } from 'react';
import { listProjects, type ProjectSummary } from './projectApi';

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listProjects().then((value) => setProjects(value.projects)).catch((reason) => setError(reason instanceof Error ? reason.message : 'Không thể tải dự án.')); }, []);
  return { projects, error };
}
