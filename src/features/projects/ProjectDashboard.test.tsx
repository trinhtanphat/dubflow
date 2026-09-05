import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CloudJob } from './jobApi';
import type { CloudProject } from './projectApi';
import { ProjectDashboard } from './ProjectDashboard';

const project: CloudProject = {
  id: 'p1', userId: 'dev-user', title: 'Episode 01', sourceLanguage: 'zh', targetLanguage: 'vi',
  status: 'needs_review', updatedAt: '2026-09-05T12:05:00Z',
};

function job(overrides: Partial<CloudJob> = {}): CloudJob {
  return {
    id: 'j1', projectId: 'p1', type: 'dubbing', status: 'failed', progress: 0.6,
    currentStep: 'transcribing', errorCode: 'ASR_FAILED', errorMessage: 'Provider down',
    retryCount: 1, createdAt: '2026-09-05T12:00:00Z', updatedAt: '2026-09-05T12:04:00Z',
    ...overrides,
  };
}

function render(projects: CloudProject[], jobsByProject: Record<string, CloudJob[]> = {}) {
  return renderToStaticMarkup(
    <ProjectDashboard
      projects={projects}
      jobsByProject={jobsByProject}
      loading={false}
      error=""
      onOpenProject={vi.fn()}
      onRetryJob={vi.fn()}
      onCancelJob={vi.fn()}
      onCreateProject={vi.fn()}
    />,
  );
}

describe('ProjectDashboard', () => {
  it('renders a useful empty state and create-project action', () => {
    const html = render([]);
    expect(html).toContain('Chưa có dự án');
    expect(html).toContain('Tạo dự án');
    expect(html).toContain('project-dashboard');
  });

  it('renders durable project metadata and a failed job retry action', () => {
    const html = render([project], { p1: [job()] });
    expect(html).toContain('Episode 01');
    expect(html).toContain('zh');
    expect(html).toContain('vi');
    expect(html).toContain('needs_review');
    expect(html).toContain('Provider down');
    expect(html).toContain('60%');
    expect(html).toContain('Thử lại');
    expect(html).not.toContain('Hủy job');
  });

  it('shows cancellation only for active durable jobs', () => {
    const html = render([project], { p1: [job({ status: 'running', errorCode: null, errorMessage: null, progress: 0.35 })] });
    expect(html).toContain('35%');
    expect(html).toContain('Hủy job');
    expect(html).not.toContain('Thử lại');
  });

  it('keeps dashboard load errors visible without dropping the shell', () => {
    const html = renderToStaticMarkup(
      <ProjectDashboard
        projects={[project]}
        jobsByProject={{}}
        loading={false}
        error="Không thể tải danh sách dự án."
        onOpenProject={vi.fn()}
        onRetryJob={vi.fn()}
        onCancelJob={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );
    expect(html).toContain('Không thể tải danh sách dự án.');
    expect(html).toContain('Episode 01');
  });
});
