import { useEffect, useState } from 'react';
import { UploadPanel, type UploadPanelProps } from '../features/upload/UploadPanel';
import { SpeakerList } from '../features/speakers/SpeakerList';
import { VideoStage } from '../features/player/VideoStage';
import { ScriptInspector } from '../features/transcript/ScriptInspector';
import { Timeline } from '../features/timeline/Timeline';
import type { CloudJob } from '../features/projects/jobApi';
import type { SegmentPatch } from '../features/transcript/segmentApi';
import type { TranslationMode } from '../features/translation/translationApi';
import { persistEditorPatch, retranslateEditorSegment } from '../features/transcript/editorPersistence';
import { followCloudJob } from './cloudJobFlow';
import { useStudioState } from './useStudioState';

export function App() {
  const { state, dispatch, selectedSegment, selectedSpeaker } = useStudioState();
  const [activeJob, setActiveJob] = useState<{ projectId: string; jobId: string } | null>(null);
  const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
  const [cloudError, setCloudError] = useState('');
  const [translationMode, setTranslationMode] = useState<TranslationMode>('workers-ai');
  const [translationComparison, setTranslationComparison] = useState<{ workersAI: string; google: string } | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState('');

  const cloudEditable = state.project.id !== 'demo';

  const onProcessStarted: NonNullable<UploadPanelProps['onProcessStarted']> = ({ project, job }) => {
    setCloudError('');
    setCloudJob({
      id: job.jobId, projectId: project.id, type: 'dubbing', status: 'queued', progress: 0,
      currentStep: 'queued', errorCode: null, errorMessage: null,
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
      (job) => { if (!controller.signal.aborted) setCloudJob(job); },
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
  }, [activeJob?.projectId, activeJob?.jobId, dispatch]);

  useEffect(() => {
    setTranslationComparison(null);
    setEditorError('');
  }, [state.selectedSegmentId]);

  const commitPatch = async (segmentId: string, patch: SegmentPatch) => {
    if (!cloudEditable) return;
    setEditorError('');
    try {
      await persistEditorPatch(state.project.id, segmentId, patch);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : 'Không thể lưu thay đổi segment.');
    }
  };

  const retranslate = async (segmentId: string) => {
    if (!cloudEditable || editorBusy) return;
    setEditorBusy(true); setEditorError(''); setTranslationComparison(null);
    try {
      const result = await retranslateEditorSegment(state.project.id, segmentId, translationMode);
      if (result.mode === 'compare') {
        setTranslationComparison({ workersAI: result.workersAI, google: result.google });
      } else {
        dispatch({ type: 'editTranslation', segmentId, text: result.segment.translatedText });
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : 'Dịch lại thất bại.');
    } finally {
      setEditorBusy(false);
    }
  };

  const applyTranslation = async (text: string) => {
    if (!selectedSegment || !cloudEditable || editorBusy) return;
    setEditorBusy(true); setEditorError('');
    try {
      const updated = await persistEditorPatch(state.project.id, selectedSegment.id, { translatedText: text });
      dispatch({ type: 'editTranslation', segmentId: selectedSegment.id, text: updated.translatedText });
      setTranslationComparison(null);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : 'Không thể áp dụng bản dịch.');
    } finally {
      setEditorBusy(false);
    }
  };

  const cloudPercent = cloudJob ? Math.round(cloudJob.progress * 100) : 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark" aria-hidden="true">◫</div><div><strong>YupVox</strong><span>AI Dubbing Studio</span></div></div>
        <div className="project-title">
          <span>Dự án:</span><strong>{state.project.title}</strong><button type="button" aria-label="Đổi tên dự án">✎</button>
          {cloudJob && <span role="status" aria-live="polite">AI {cloudPercent}% · {cloudJob.currentStep ?? cloudJob.status}</span>}
        </div>
        <div className="topbar-actions">
          <div className="cloud-badge"><span>☁</span><div><strong>Cloud Mode</strong><small>{activeJob ? 'Processing' : '24/7 Ready'}</small></div></div>
          <div className="credits"><span>✦</span><div><strong>50,000 Credits</strong><small>Demo ledger</small></div></div>
          <div className="avatar">YV</div>
          <button className="export-button" type="button" disabled>⇧ Xuất bản Dubbing · Phase 2</button>
        </div>
      </header>

      {cloudError && <div className="error-banner" role="alert">{cloudError}</div>}

      <main className="studio-grid" aria-label="DubFlow dubbing workspace">
        <aside className="left-rail">
          <UploadPanel onProcessStarted={onProcessStarted} />
          <SpeakerList speakers={state.project.speakers} selectedSpeakerId={selectedSpeaker?.id} />
        </aside>

        <section className="center-stage">
          <VideoStage segment={selectedSegment} playheadMs={state.playheadMs} durationMs={state.project.durationMs} />
          <Timeline project={state.project} playheadMs={state.playheadMs} selectedSegmentId={state.selectedSegmentId} dispatch={dispatch} />
        </section>

        <ScriptInspector
          segment={selectedSegment}
          speakers={state.project.speakers}
          lipSyncEnabled={state.lipSyncEnabled}
          dispatch={dispatch}
          cloudEditable={cloudEditable}
          translationMode={translationMode}
          onTranslationModeChange={setTranslationMode}
          onCommitPatch={commitPatch}
          onRetranslate={retranslate}
          comparison={translationComparison}
          onApplyTranslation={applyTranslation}
          busy={editorBusy}
          error={editorError}
        />
      </main>

      <footer className="capability-strip">
        <span>🌐 Dub đa ngôn ngữ</span><span>♙ Tự nhận diện nhân vật</span><span>♬ Voice provider-ready</span><span>☁ Cloudflare-first</span><span>⌁ Workers AI + Google Translate</span>
      </footer>
    </div>
  );
}
