import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CloudJob } from './jobApi';
import type { CloudProject } from './projectApi';
import { ProjectDashboard } from './ProjectDashboard';
import type { UsageSummary } from './usageApi';

const project: CloudProject = {
  id: 'p1', userId: 'dev-user', title: 'Episode 01', sourceLanguage: 'zh', targetLanguage: 'vi',
  status: 'needs_review', updatedAt: '2026-09-05T12:05:00Z',
};

const usageSummary: UsageSummary = {
  allocatedCredits: 50_000,
  usedCredits: 37,
  remainingCredits: 49_963,
  overageCredits: 0,
  totals: [
    { kind: 'asr_audio_seconds', units: 60, credits: 10 },
    { kind: 'translation_characters', units: 1_400, credits: 7 },
    { kind: 'tts_characters', units: 1_000, credits: 20 },
  ],
  providers: [
    { provider: 'deepgram-nova-3', kind: 'asr_audio_seconds', units: 60, credits: 10 },
    { provider: 'workers-ai', kind: 'translation_characters', units: 1_000, credits: 5 },
    { provider: 'google', kind: 'translation_characters', units: 400, credits: 2 },
    { provider: 'elevenlabs', kind: 'tts_characters', units: 1_000, credits: 20 },
  ],
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
      usageSummary={usageSummary}
      usageLoading={false}
      usageError=""
      onOpenProject={vi.fn()}
      onRetryJob={vi.fn()}
      onCancelJob={vi.fn()}
      onCreateProject={vi.fn()}
    />
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
        usageSummary={usageSummary}
        usageLoading={false}
        usageError=""
        onOpenProject={vi.fn()}
        onRetryJob={vi.fn()}
        onCancelJob={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );
    expect(html).toContain('Không thể tải danh sách dự án.');
    expect(html).toContain('Episode 01');
  });

  it('renders credit cards, billable unit totals and provider breakdown from the usage summary', () => {
    const html = render([project]);
    expect(html).toContain('Tín dụng còn lại');
    expect(html).toContain('49.963');
    expect(html).toContain('Đã sử dụng');
    expect(html).toContain('37');
    expect(html).toContain('Đơn vị tính phí');
    expect(html).toContain('ASR');
    expect(html).toContain('60 giây');
    expect(html).toContain('Dịch');
    expect(html).toContain('1.400 ký tự');
    expect(html).toContain('TTS');
    expect(html).toContain('1.000 ký tự');
    expect(html).toContain('deepgram-nova-3');
    expect(html).toContain('workers-ai');
    expect(html).toContain('google');
    expect(html).toContain('elevenlabs');
  });

  it('isolates usage loading and usage errors from project and job controls', () => {
    const loadingHtml = renderToStaticMarkup(
      <ProjectDashboard
        projects={[project]}
        jobsByProject={{ p1: [job()] }}
        loading={false}
        error=""
        usageSummary={null}
        usageLoading={true}
        usageError=""
        onOpenProject={vi.fn()}
        onRetryJob={vi.fn()}
        onCancelJob={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );
    expect(loadingHtml).toContain('Đang tải mức sử dụng');
    expect(loadingHtml).toContain('Mở dự án');
    expect(loadingHtml).toContain('Thử lại');

    const errorHtml = renderToStaticMarkup(
      <ProjectDashboard
        projects={[project]}
        jobsByProject={{ p1: [job()] }}
        loading={false}
        error=""
        usageSummary={null}
        usageLoading={false}
        usageError="Không thể tải mức sử dụng."
        onOpenProject={vi.fn()}
        onRetryJob={vi.fn()}
        onCancelJob={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );
    expect(errorHtml).toContain('Không thể tải mức sử dụng.');
    expect(errorHtml).toContain('Episode 01');
    expect(errorHtml).toContain('Mở dự án');
    expect(errorHtml).toContain('Thử lại');
  });
});
