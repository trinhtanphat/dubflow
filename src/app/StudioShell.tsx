import { useEffect, useState } from 'react';
import { UploadPanel, type UploadPanelProps } from '../features/upload/UploadPanel';
import { SpeakerList } from '../features/speakers/SpeakerList';
import { VideoStage } from '../features/player/VideoStage';
import { ScriptInspector } from '../features/transcript/ScriptInspector';
import { Timeline } from '../features/timeline/Timeline';
import type { CloudJob } from '../features/projects/jobApi';
import type { useStudioState } from './useStudioState';
import { followCloudJob } from './cloudJobFlow';
import { StudioTopbar } from './StudioTopbar';

type StudioShellProps = ReturnType<typeof useStudioState>;
type MobilePanel = 'none' | 'sources' | 'inspector';

export function StudioShell({ state, dispatch, selectedSegment, selectedSpeaker }: StudioShellProps) {
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');
  const [activeJob, setActiveJob] = useState<{ projectId: string; jobId: string } | null>(null);
  const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
  const [cloudError, setCloudError] = useState('');

  const toggleMobilePanel = (panel: Exclude<MobilePanel, 'none'>) => {
    setMobilePanel((current) => current === panel ? 'none' : panel);
  };

  const onProcessStarted: NonNullable<UploadPanelProps['onProcessStarted']> = ({ project, job }) => {
    setCloudError('');
    setCloudJob({
      id: job.jobId,
      projectId: project.id,
      type: 'dubbing',
      status: 'queued',
      progress: 0,
      currentStep: 'queued',
      errorCode: null,
      errorMessage: null,
    });
    setActiveJob({ projectId: project.id, jobId: job.jobId });
  };

  useEffect(() => {
    if (!activeJob) return;
    const controller = new AbortController();
    followCloudJob(
      activeJob.projectId,
      activeJob.jobId,
      undefined,
      controller.signal,
      (job) => {
        if (!controller.signal.aborted) setCloudJob(job);
      },
    ).then((project) => {
      if (controller.signal.aborted) return;
      if (project) dispatch({ type: 'hydrateProject', project });
      setActiveJob(null);
    }).catch((error) => {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      setCloudError(error instanceof Error ? error.message : 'Cloud dubbing thất bại.');
      setActiveJob(null);
    });
    return () => controller.abort();
  }, [activeJob, dispatch]);

  const cloudState = activeJob ? 'processing' : cloudError ? 'degraded' : 'ready';
  const cloudDetail = cloudError || cloudJob?.currentStep || (cloudJob ? cloudJob.status : undefined);

  return (
    <div className={`app-shell studio-pro-shell mobile-panel--${mobilePanel}`}>
      <StudioTopbar
        projectTitle={state.project.title}
        saveState="offline"
        cloudState={cloudState}
        cloudProgress={cloudJob?.progress}
        cloudDetail={cloudDetail}
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
        onOpenSources={() => toggleMobilePanel('sources')}
        onOpenInspector={() => toggleMobilePanel('inspector')}
      />

      {cloudError && <div className="error-banner" role="alert">{cloudError}</div>}

      <main className="studio-grid" aria-label="DubFlow dubbing workspace">
        <aside className="left-rail" aria-label="Nguồn media và nhân vật">
          <UploadPanel onProcessStarted={onProcessStarted} />
          <SpeakerList speakers={state.project.speakers} selectedSpeakerId={selectedSpeaker?.id} />
        </aside>

        <section className="center-stage" aria-label="Không gian chỉnh sửa">
          <VideoStage segment={selectedSegment} playheadMs={state.playheadMs} durationMs={state.project.durationMs} />
          <Timeline project={state.project} playheadMs={state.playheadMs} selectedSegmentId={state.selectedSegmentId} dispatch={dispatch} />
        </section>

        <ScriptInspector segment={selectedSegment} speakers={state.project.speakers} lipSyncEnabled={state.lipSyncEnabled} dispatch={dispatch} />
      </main>

      <button
        type="button"
        className="mobile-panel-backdrop"
        aria-label="Đóng bảng phụ"
        onClick={() => setMobilePanel('none')}
      />

      <footer className="capability-strip studio-capability-strip" aria-label="Năng lực hệ thống">
        <span><i className="capability-dot capability-dot--ready" />Workers AI translation</span>
        <span><i className="capability-dot capability-dot--optional" />Google Translation · optional</span>
        <span><i className="capability-dot capability-dot--ready" />R2 multipart media</span>
        <span><i className="capability-dot capability-dot--ready" />D1 project state</span>
        <span><i className="capability-dot capability-dot--guarded" />Voice · capability-aware</span>
      </footer>
    </div>
  );
}
