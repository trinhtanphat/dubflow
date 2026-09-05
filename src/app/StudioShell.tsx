import { useEffect, useState } from 'react';
import { UploadPanel, type UploadPanelProps } from '../features/upload/UploadPanel';
import { SpeakerList } from '../features/speakers/SpeakerList';
import { VideoStage } from '../features/player/VideoStage';
import { ScriptInspector } from '../features/transcript/ScriptInspector';
import { Timeline, type SegmentEditIntent } from '../features/timeline/Timeline';
import {
  commitSegmentSplit,
  commitSegmentTiming,
  persistRedo,
  persistUndo,
} from '../features/timeline/segmentMutationService';
import { startExport, type CloudJob } from '../features/projects/jobApi';
import type { SegmentPatch } from '../features/transcript/segmentApi';
import type { TranslationMode } from '../features/translation/translationApi';
import { persistEditorPatch, retranslateEditorSegment } from '../features/transcript/editorPersistence';
import type { EditorMutation } from './editorHistory';
import type { StudioAction, StudioState } from './studioState';
import type { useStudioState } from './useStudioState';
import { followCloudJob } from './cloudJobFlow';
import { loadCloudStudioProject } from './cloudHydration';
import { StudioTopbar } from './StudioTopbar';

type StudioShellProps = ReturnType<typeof useStudioState>;
type MobilePanel = 'none' | 'sources' | 'inspector';

type StudioEditorServices = {
  commitSegmentTiming: typeof commitSegmentTiming;
  commitSegmentSplit: typeof commitSegmentSplit;
  persistUndo: typeof persistUndo;
  persistRedo: typeof persistRedo;
};

type StudioEditorActionOptions = {
  state: StudioState;
  dispatch: (action: StudioAction) => void;
  cloudEditable: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string) => void;
  restoreCloudProject: () => Promise<void>;
  services?: StudioEditorServices;
};

const defaultStudioEditorServices: StudioEditorServices = {
  commitSegmentTiming,
  commitSegmentSplit,
  persistUndo,
  persistRedo,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function createStudioEditorActions({
  state,
  dispatch,
  cloudEditable,
  busy,
  setBusy,
  setError,
  restoreCloudProject,
  services = defaultStudioEditorServices,
}: StudioEditorActionOptions) {
  const commitSegmentEdit = async (intent: SegmentEditIntent) => {
    if (!cloudEditable || busy) {
      dispatch({ type: 'cancelSegmentPreview' });
      return;
    }
    const before = state.project.segments.find((segment) => segment.id === intent.segmentId);
    if (!before) {
      dispatch({ type: 'cancelSegmentPreview' });
      return;
    }

    setBusy(true);
    setError('');
    try {
      const mutation = await services.commitSegmentTiming(state.project.id, before, {
        startMs: intent.startMs,
        endMs: intent.endMs,
      });
      dispatch({ type: 'commitTimingMutation', before: mutation.before, after: mutation.after });
    } catch (error) {
      dispatch({ type: 'cancelSegmentPreview' });
      setError(errorMessage(error, 'Không thể lưu thay đổi timing.'));
      await restoreCloudProject();
    } finally {
      setBusy(false);
    }
  };

  const splitSelected = async () => {
    if (!cloudEditable || busy) return;
    const originalBefore = state.project.segments.find((segment) => segment.id === state.selectedSegmentId);
    if (!originalBefore) return;

    setBusy(true);
    setError('');
    try {
      const mutation = await services.commitSegmentSplit(state.project.id, originalBefore, state.playheadMs);
      dispatch({
        type: 'commitSplitMutation',
        originalBefore: mutation.originalBefore,
        leftAfter: mutation.leftAfter,
        rightAfter: mutation.rightAfter,
      });
    } catch (error) {
      setError(errorMessage(error, 'Không thể tách segment.'));
      await restoreCloudProject();
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!cloudEditable || busy) return;
    const mutation = state.history.past.at(-1);
    if (!mutation) return;

    setBusy(true);
    setError('');
    dispatch({ type: 'applyUndoLocal' });
    try {
      await services.persistUndo(state.project.id, mutation);
    } catch (error) {
      dispatch({ type: 'applyRedoLocal' });
      setError(errorMessage(error, 'Không thể hoàn tác thay đổi.'));
    } finally {
      setBusy(false);
    }
  };

  const redo = async () => {
    if (!cloudEditable || busy) return;
    const mutation = state.history.future[0];
    if (!mutation) return;

    setBusy(true);
    setError('');
    dispatch({ type: 'applyRedoLocal' });
    try {
      const canonical: EditorMutation = await services.persistRedo(state.project.id, mutation);
      if (mutation.kind === 'split' && canonical.kind === 'split') {
        dispatch({
          type: 'reconcileLatestSplitMutation',
          previousRightId: mutation.rightAfter.id,
          mutation: canonical,
        });
      }
    } catch (error) {
      dispatch({ type: 'applyUndoLocal' });
      setError(errorMessage(error, 'Không thể làm lại thay đổi.'));
    } finally {
      setBusy(false);
    }
  };

  return { commitSegmentEdit, splitSelected, undo, redo };
}

function isNativeTextUndoTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function StudioShell({ state, dispatch, selectedSegment, selectedSpeaker }: StudioShellProps) {
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');
  const [activeJob, setActiveJob] = useState<{ projectId: string; jobId: string } | null>(null);
  const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
  const [cloudError, setCloudError] = useState('');
  const [translationMode, setTranslationMode] = useState<TranslationMode>('workers-ai');
  const [translationComparison, setTranslationComparison] = useState<{ workersAI: string; google: string } | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState('');

  const cloudEditable = state.project.id !== 'demo';

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

  const startFinalExport = async () => {
    if (!cloudEditable || activeJob || editorBusy) return;
    setCloudError('');
    try {
      const job = await startExport(state.project.id);
      setCloudJob({
        id: job.jobId,
        projectId: state.project.id,
        type: 'export',
        status: 'queued',
        progress: 0,
        currentStep: 'queued',
        errorCode: null,
        errorMessage: null,
      });
      setActiveJob({ projectId: state.project.id, jobId: job.jobId });
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : 'Không thể bắt đầu xuất bản Dubbing.');
    }
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

  useEffect(() => {
    setTranslationComparison(null);
    setEditorError('');
  }, [state.selectedSegmentId]);

  const restoreCloudProject = async () => {
    if (!cloudEditable) return;
    try {
      const project = await loadCloudStudioProject(state.project.id);
      dispatch({ type: 'hydrateProject', project });
    } catch {
      // Preserve the visible error from the original failed mutation.
    }
  };

  const editorActions = createStudioEditorActions({
    state,
    dispatch,
    cloudEditable,
    busy: editorBusy,
    setBusy: setEditorBusy,
    setError: setEditorError,
    restoreCloudProject,
  });

  useEffect(() => {
    const handleEditorHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
      if (isNativeTextUndoTarget(event.target) || editorBusy) return;
      if (event.shiftKey) {
        if (state.history.future.length === 0 || !cloudEditable) return;
        event.preventDefault();
        void editorActions.redo();
        return;
      }
      if (state.history.past.length === 0 || !cloudEditable) return;
      event.preventDefault();
      void editorActions.undo();
    };
    window.addEventListener('keydown', handleEditorHistoryShortcut);
    return () => window.removeEventListener('keydown', handleEditorHistoryShortcut);
  }, [cloudEditable, editorBusy, editorActions, state.history.future.length, state.history.past.length]);

  const commitPatch = async (segmentId: string, patch: SegmentPatch) => {
    if (!cloudEditable) return;
    setEditorError('');
    try {
      const updated = await persistEditorPatch(state.project.id, segmentId, patch);
      if (patch.sourceText !== undefined) {
        dispatch({ type: 'editSource', segmentId, text: updated.sourceText });
      }
      if (patch.translatedText !== undefined) {
        dispatch({ type: 'editTranslation', segmentId, text: updated.translatedText });
      }
      if (patch.speakerId !== undefined && updated.speakerId && state.project.speakers.some((speaker) => speaker.id === updated.speakerId)) {
        dispatch({ type: 'assignSpeaker', segmentId, speakerId: updated.speakerId });
      }
      if (patch.translatedText !== undefined || patch.speakerId !== undefined) await restoreCloudProject();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : 'Không thể lưu thay đổi segment.');
      await restoreCloudProject();
    }
  };

  const retranslate = async (segmentId: string) => {
    if (!cloudEditable || editorBusy) return;
    setEditorBusy(true);
    setEditorError('');
    setTranslationComparison(null);
    try {
      const result = await retranslateEditorSegment(state.project.id, segmentId, translationMode);
      if (result.mode === 'compare') {
        setTranslationComparison({ workersAI: result.workersAI, google: result.google });
      } else {
        dispatch({ type: 'editTranslation', segmentId, text: result.segment.translatedText });
        await restoreCloudProject();
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : 'Dịch lại thất bại.');
    } finally {
      setEditorBusy(false);
    }
  };

  const applyTranslation = async (text: string) => {
    if (!selectedSegment || !cloudEditable || editorBusy) return;
    setEditorBusy(true);
    setEditorError('');
    try {
      const updated = await persistEditorPatch(state.project.id, selectedSegment.id, { translatedText: text });
      dispatch({ type: 'editTranslation', segmentId: selectedSegment.id, text: updated.translatedText });
      setTranslationComparison(null);
      await restoreCloudProject();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : 'Không thể áp dụng bản dịch.');
      await restoreCloudProject();
    } finally {
      setEditorBusy(false);
    }
  };

  const cloudState = activeJob ? 'processing' : cloudError ? 'degraded' : 'ready';
  const cloudDetail = cloudError || cloudJob?.currentStep || (cloudJob ? cloudJob.status : undefined);
  const saveState = !cloudEditable ? 'offline' : editorError ? 'error' : editorBusy ? 'saving' : 'saved';
  const canUndo = cloudEditable && !editorBusy && state.history.past.length > 0;
  const canRedo = cloudEditable && !editorBusy && state.history.future.length > 0;
  const exportBusy = Boolean(activeJob && cloudJob?.type === 'export');
  const canExport = cloudEditable
    && !activeJob
    && !editorBusy
    && !state.project.exportObjectKey
    && (state.project.status === 'needs_review' || state.project.status === 'completed');
  const exportHref = state.project.exportObjectKey
    ? `/api/projects/${encodeURIComponent(state.project.id)}/export/media`
    : undefined;

  return (
    <div className={`app-shell studio-pro-shell reference-fidelity mobile-panel--${mobilePanel}`}>
      <StudioTopbar
        projectTitle={state.project.title}
        saveState={saveState}
        cloudState={cloudState}
        cloudProgress={cloudJob?.progress}
        cloudDetail={cloudDetail}
        canUndo={canUndo}
        canRedo={canRedo}
        canExport={canExport}
        exportBusy={exportBusy}
        exportHref={exportHref}
        onExport={() => { void startFinalExport(); }}
        onUndo={() => { void editorActions.undo(); }}
        onRedo={() => { void editorActions.redo(); }}
        onOpenCommands={() => {}}
        onOpenSources={() => toggleMobilePanel('sources')}
        onOpenInspector={() => toggleMobilePanel('inspector')}
      />

      {cloudError && <div className="error-banner" role="alert">{cloudError}</div>}
      {editorError && <div className="error-banner editor-error-banner" role="alert">{editorError}</div>}

      <main className="studio-grid" aria-label="DubFlow dubbing workspace">
        <aside className="left-rail" aria-label="Nguồn media và nhân vật">
          <UploadPanel onProcessStarted={onProcessStarted} speakerSection={<SpeakerList speakers={state.project.speakers} selectedSpeakerId={selectedSpeaker?.id} />} />
        </aside>

        <section className="center-stage" aria-label="Không gian chỉnh sửa">
          <VideoStage
            project={state.project}
            segment={selectedSegment}
            playheadMs={state.playheadMs}
            playback={state.playback}
            dispatch={dispatch}
          />
          <Timeline
            project={state.project}
            playheadMs={state.playheadMs}
            selectedSegmentId={state.selectedSegmentId}
            timelineView={state.timelineView}
            segmentPreview={state.segmentPreview}
            dispatch={dispatch}
            onCommitSegmentEdit={editorActions.commitSegmentEdit}
            onSplitSelected={editorActions.splitSelected}
          />
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

      <button
        type="button"
        className="mobile-panel-backdrop"
        aria-label="Đóng bảng phụ"
        onClick={() => setMobilePanel('none')}
      />

      <footer className="capability-strip studio-capability-strip reference-feature-strip" aria-label="Năng lực hệ thống">
        <span><i className="capability-dot capability-dot--ready" />Dub mọi ngôn ngữ</span>
        <span><i className="capability-dot capability-dot--ready" />Tự nhận diện nhân vật</span>
        <span><i className="capability-dot capability-dot--guarded" />Voice preservation <small>Capability-gated</small></span>
        <span><i className="capability-dot capability-dot--ready" />Chạy trên Cloud 24/7</span>
        <span><i className="capability-dot capability-dot--guarded" />AI voices <small>Capability-gated</small></span>
      </footer>
    </div>
  );
}
