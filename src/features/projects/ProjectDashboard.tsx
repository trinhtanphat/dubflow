import type { CloudJob } from './jobApi';
import type { CloudProject } from './projectApi';

export type ProjectDashboardProps = {
  projects: CloudProject[];
  jobsByProject: Record<string, CloudJob[]>;
  loading: boolean;
  error: string;
  onOpenProject(projectId: string): void;
  onRetryJob(projectId: string, jobId: string): void;
  onCancelJob(projectId: string, jobId: string): void;
  onCreateProject(): void;
};

const activeStatuses = new Set<CloudJob['status']>(['queued', 'running', 'retrying']);

function progressLabel(progress: number): string {
  if (!Number.isFinite(progress)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}

function updatedLabel(value?: string): string {
  if (!value) return 'Chưa có thời gian cập nhật';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ProjectDashboard({
  projects,
  jobsByProject,
  loading,
  error,
  onOpenProject,
  onRetryJob,
  onCancelJob,
  onCreateProject,
}: ProjectDashboardProps) {
  return (
    <main className="project-dashboard" aria-label="Bảng dự án YupVox">
      <header className="project-dashboard__header">
        <div>
          <span className="project-dashboard__eyebrow">YupVox.Com · AI Studio Dubbing</span>
          <h1>Dự án dubbing</h1>
          <p>Tiếp tục dự án, xem job gần nhất và xử lý lỗi mà không mất trạng thái trên Cloud.</p>
        </div>
        <button className="project-dashboard__create" type="button" onClick={onCreateProject}>Tạo dự án</button>
      </header>

      {error ? <div className="project-dashboard__error" role="alert">{error}</div> : null}
      {loading ? <div className="project-dashboard__loading" role="status">Đang tải dự án…</div> : null}

      {!loading && projects.length === 0 ? (
        <section className="project-dashboard__empty" aria-label="Chưa có dự án">
          <strong>Chưa có dự án</strong>
          <span>Tạo dự án đầu tiên để tải video và bắt đầu AI dubbing.</span>
          <button type="button" onClick={onCreateProject}>Tạo dự án</button>
        </section>
      ) : null}

      <section className="project-dashboard__grid" aria-label="Danh sách dự án">
        {projects.map((project) => {
          const latestJob = jobsByProject[project.id]?.[0];
          const canRetry = latestJob?.status === 'failed';
          const canCancel = Boolean(latestJob && activeStatuses.has(latestJob.status));
          return (
            <article className="project-card" key={project.id}>
              <div className="project-card__topline">
                <span className={`project-card__status project-card__status--${project.status}`}>{project.status}</span>
                <span className="project-card__updated">{updatedLabel(project.updatedAt)}</span>
              </div>

              <div className="project-card__title-row">
                <div>
                  <h2>{project.title}</h2>
                  <p>{project.sourceLanguage} → {project.targetLanguage}</p>
                </div>
                <button type="button" onClick={() => onOpenProject(project.id)}>Mở dự án</button>
              </div>

              {latestJob ? (
                <section className="project-job" aria-label={`Job gần nhất của ${project.title}`}>
                  <div className="project-job__heading">
                    <span>{latestJob.type}</span>
                    <strong>{latestJob.status}</strong>
                    <span>{progressLabel(latestJob.progress)}</span>
                  </div>
                  <div className="project-job__track" aria-hidden="true">
                    <span style={{ width: progressLabel(latestJob.progress) }} />
                  </div>
                  <div className="project-job__detail">
                    <span>{latestJob.currentStep || 'Không có bước đang chạy'}</span>
                    {typeof latestJob.retryCount === 'number' && latestJob.retryCount > 0
                      ? <span>Đã thử lại {latestJob.retryCount} lần</span>
                      : null}
                  </div>
                  {latestJob.errorMessage ? (
                    <p className="project-job__error" role="alert">{latestJob.errorMessage}</p>
                  ) : null}
                  {canRetry || canCancel ? (
                    <div className="project-job__actions">
                      {canRetry ? (
                        <button type="button" onClick={() => onRetryJob(project.id, latestJob.id)}>Thử lại</button>
                      ) : null}
                      {canCancel ? (
                        <button type="button" onClick={() => onCancelJob(project.id, latestJob.id)}>Hủy job</button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : (
                <p className="project-card__no-job">Chưa có job xử lý cho dự án này.</p>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}
