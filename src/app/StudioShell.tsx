import { useCallback, useEffect, useRef, useState } from 'react';
import { CommandPalette } from '../components/CommandPalette/CommandPalette';
import { UploadPanel, type UploadPanelProps } from '../features/upload/UploadPanel';
import { SpeakerList } from '../features/speakers/SpeakerList';
import { VideoStage } from '../features/player/VideoStage';
import { ScriptInspector } from '../features/transcript/ScriptInspector';
import { SharePanel } from '../features/sharing/SharePanel';
import { MIN_SEGMENT_MS } from '../features/timeline/editing';
import { Timeline, type SegmentEditIntent } from '../features/timeline/Timeline';
import {
  commitSegmentSplit,
  commitSegmentTiming,
  persistRedo,
  persistUndo,
} from '../features/timeline/segmentMutationService';
import type { Segment } from '../features/timeline/types';
import { startExport, type CloudJob } from '../features/projects/jobApi';
import { TranslationSettingsPanel } from '../features/translation/TranslationSettingsPanel';
import { TargetLanguagesPanel, type StudioLanguage } from '../features/translation/TargetLanguagesPanel';
import {
  TranslationVariantConflictError,
  getTranslationVariants,
  patchTranslationVariant,
  type TargetLanguage,
  type TranslationVariantDto,
} from '../features/translation/languageVariantsApi';
import { BatchExportPanel } from '../features/export/BatchExportPanel';
import type { TranslationMode } from '../features/translation/translationApi';
import { retranslateEditorSegment } from '../features/transcript/editorPersistence';
import { SegmentVersionConflictError, type CloudSegment } from '../features/transcript/segmentApi';
import type { SegmentFieldPatch } from './autosaveDraft';
import type { EditorMutation } from './editorHistory';
import { resolveStudioShortcut } from './shortcuts';
import { buildStudioCommands } from './studioCommands';
import type { StudioAction, StudioState } from './studioState';
import type { useStudioState } from './useStudioState';
import { followCloudJob } from './cloudJobFlow';
import { loadCloudStudioProject } from './cloudHydration';
import { StudioTopbar, type SaveState } from './StudioTopbar';
import { useSegmentAutosave } from './useSegmentAutosave';

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

export function isStudioMutationLocked(editorBusy: boolean, hasActiveJob: boolean): boolean {
  return editorBusy || hasActiveJob;
}

function toStudioSegment(segment: CloudSegment): Segment {
  return {
    id: segment.id,
    speakerId: segment.speakerId?.trim() || 'unassigned',
    startMs: segment.startMs,
    endMs: segment.endMs,
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
    version: segment.version,
  };
}

export function composeTargetSegment(canonical: Segment, variant?: TranslationVariantDto | null): Segment {
  return {
    ...canonical,
    translatedText: variant?.translation?.translatedText ?? canonical.translatedText,
  };
}

function historyFieldPatch(mutation: EditorMutation, direction: 'undo' | 'redo'): SegmentFieldPatch | null {
  if (mutation.kind !== 'fields') return null;
  const source = direction === 'undo' ? mutation.before : mutation.after;
  const patch: SegmentFieldPatch = {};
  for (const field of mutation.fields) {
    if (field === 'sourceText') patch.sourceText = source.sourceText;
    else if (field === 'translatedText') patch.translatedText = source.translatedText;
    else patch.speakerId = source.speakerId;
  }
  return patch;
}

function dispatchFieldHistoryConflict(
  dispatch: (action: StudioAction) => void,
  mutation: EditorMutation,
  direction: 'undo' | 'redo',
  error: SegmentVersionConflictError,
): boolean {
  const patch = historyFieldPatch(mutation, direction);
  if (!patch || mutation.kind !== 'fields') return false;
  const canonical = toStudioSegment(error.canonical);
  dispatch({ type: 'editDraft', segmentId: mutation.segmentId, patch });
  dispatch({ type: 'conflictDraftSave', segmentId: mutation.segmentId, canonical });
  return true;
}

export function deriveStudioSaveState(
  state: StudioState,
  cloudEditable: boolean,
  editorError: string,
  editorBusy: boolean,
): SaveState {
  if (!cloudEditable) return 'offline';
  const phases = Object.values(state.drafts).map((draft) => draft.phase);
  if (phases.includes('conflict')) return 'conflict';
  if (phases.includes('error') || Boolean(editorError)) return 'error';
  if (phases.includes('saving') || editorBusy) return 'saving';
  if (phases.includes('dirty')) return 'dirty';
  return 'saved';
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
      const canonical = await services.persistUndo(state.project.id, mutation, state.project);
      dispatch({ type: 'reconcileHistoryMutation', direction: 'undo', previous: mutation, mutation: canonical });
    } catch (error) {
      dispatch({ type: 'applyRedoLocal' });
      if (error instanceof SegmentVersionConflictError && dispatchFieldHistoryConflict(dispatch, mutation, 'undo', error)) {
        return;
      }
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
      const canonical = await services.persistRedo(state.project.id, mutation, state.project);
      dispatch({ type: 'reconcileHistoryMutation', direction: 'redo', previous: mutation, mutation: canonical });
    } catch (error) {
      dispatch({ type: 'applyUndoLocal' });
      if (error instanceof SegmentVersionConflictError && dispatchFieldHistoryConflict(dispatch, mutation, 'redo', error)) {
        return;
      }
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

function isTimelineShortcutTarget(target: EventTarget | null): boolean {
  return typeof HTMLElement !== 'undefined'
    && target instanceof HTMLElement
    && Boolean(target.closest('.timeline-panel'));
}

export function StudioShell({ state, dispatch, selectedSegment, selectedSpeaker }: StudioShellProps) {
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');
  const [activeJob, setActiveJob] = useState<{ projectId: string; jobId: string } | null>(null);
  const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
  const [cloudError, setCloudError] = useState('');
  const [translationMode, setTranslationMode] = useState<TranslationMode | undefined>(undefined);
  const [translationComparison, setTranslationComparison] = useState<{ workersAI: string; google: string } | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [currentLanguage, setCurrentLanguage] = useState<StudioLanguage>('vi');
  const [selectedExportLanguages, setSelectedExportLanguages] = useState<TargetLanguage[]>(['vi']);
  const [targetVariants, setTargetVariants] = useState<Record<string, TranslationVariantDto>>({});
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const closeCommandPalette = useCallback(() => setCommandPaletteOpen(false), []);
  const previousSelectedSegmentId = useRef(state.selectedSegmentId);

  const cloudEditable = state.project.id !== 'demo';
  const mutationLocked = isStudioMutationLocked(editorBusy, Boolean(activeJob));
  const autosave = useSegmentAutosave({ state, dispatch });
  const selectedDraft = selectedSegment ? state.drafts[selectedSegment.id] : undefined;
  const targetLanguage = currentLanguage === 'source' ? null : currentLanguage;
  const selectedInspectorSegment = selectedSegment && targetLanguage
    ? composeTargetSegment(selectedSegment, targetVariants[selectedSegment.id])
    : selectedSegment;
  const targetEditing = Boolean(targetLanguage && targetLanguage !== 'vi');

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
    if (!cloudEditable || mutationLocked || deriveStudioSaveState(state, cloudEditable, editorError, editorBusy) !== 'saved') return;
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
    if (!cloudEditable || !targetLanguage) {
      setTargetVariants({});
      return;
    }
    let active = true;
    getTranslationVariants(state.project.id, targetLanguage).then((variants) => {
      if (!active) return;
      setTargetVariants(Object.fromEntries(variants.map((variant) => [variant.segmentId, variant])));
    }).catch((error) => {
      if (active) setEditorError(errorMessage(error, 'Không thể tải bản dịch ngôn ngữ đích.'));
    });
    return () => { active = false; };
  }, [cloudEditable, state.project.id, targetLanguage]);

  useEffect(() => {
    const previousId = previousSelectedSegmentId.current;
    if (previousId && previousId !== state.selectedSegmentId) {
      void autosave.flush(previousId);
    }
    previousSelectedSegmentId.current = state.selectedSegmentId;
  }, [state.selectedSegmentId]);

  useEffect(() => {
    setTranslationComparison(null);
    setEditorError('');
  }, [state.selectedSegmentId, currentLanguage]);

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
    busy: mutationLocked,
    setBusy: setEditorBusy,
    setError: setEditorError,
    restoreCloudProject,
  });

  const retranslate = async (segmentId: string) => {
    if (!cloudEditable || mutationLocked || targetEditing) return;
    const current = state.project.segments.find((segment) => segment.id === segmentId);
    if (!current) return;
    setEditorBusy(true);
    setEditorError('');
    setTranslationComparison(null);
    try {
      const result = await retranslateEditorSegment(state.project.id, segmentId, current.version, translationMode);
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

  const editInspectorDraft = (segmentId: string, patch: SegmentFieldPatch) => {
    if (!targetEditing || !targetLanguage) {
      autosave.edit(segmentId, patch);
      return;
    }
    const { translatedText, ...canonicalPatch } = patch;
    if (Object.keys(canonicalPatch).length > 0) autosave.edit(segmentId, canonicalPatch);
    if (translatedText === undefined) return;
    setTargetVariants((current) => {
      const existing = current[segmentId];
      if (!existing?.translation) return current;
      return {
        ...current,
        [segmentId]: { ...existing, translation: { ...existing.translation, translatedText } },
      };
    });
  };

  const flushInspectorDraft = async (segmentId: string) => {
    if (targetEditing && targetLanguage) {
      const variant = targetVariants[segmentId];
      if (variant?.translation) {
        setEditorBusy(true);
        setEditorError('');
        try {
          const saved = await patchTranslationVariant(
            state.project.id,
            targetLanguage,
            segmentId,
            variant.translation.version,
            variant.translation.translatedText,
          );
          setTargetVariants((current) => ({
            ...current,
            [segmentId]: { ...variant, translation: saved },
          }));
        } catch (error) {
          if (error instanceof TranslationVariantConflictError) {
            setTargetVariants((current) => ({
              ...current,
              [segmentId]: { ...variant, translation: error.canonical },
            }));
            setEditorError('Bản dịch ngôn ngữ này đã thay đổi ở nơi khác. Đã tải bản mới nhất.');
          } else {
            setEditorError(errorMessage(error, 'Không thể lưu bản dịch ngôn ngữ đích.'));
          }
        } finally {
          setEditorBusy(false);
        }
      }
    }
    await autosave.flush(segmentId);
  };

  const applyTranslation = async (text: string) => {
    if (!selectedSegment || !cloudEditable || mutationLocked) return;
    setEditorError('');
    editInspectorDraft(selectedSegment.id, { translatedText: text });
    setTranslationComparison(null);
    await flushInspectorDraft(selectedSegment.id);
  };

  const cloudState = activeJob ? 'processing' : cloudError ? 'degraded' : 'ready';
  const cloudDetail = cloudError || cloudJob?.currentStep || (cloudJob ? cloudJob.status : undefined);
  const saveState = deriveStudioSaveState(state, cloudEditable, editorError, editorBusy);
  const canUndo = cloudEditable && !mutationLocked && state.history.past.length > 0;
  const canRedo = cloudEditable && !mutationLocked && state.history.future.length > 0;
  const canSplit = Boolean(
    selectedSegment
      && cloudEditable
      && !mutationLocked
      && state.playheadMs > selectedSegment.startMs + MIN_SEGMENT_MS
      && state.playheadMs < selectedSegment.endMs - MIN_SEGMENT_MS,
  );
  const exportBusy = Boolean(activeJob && cloudJob?.type === 'export');
  const canExport = cloudEditable
    && !mutationLocked
    && saveState === 'saved'
    && !state.project.exportObjectKey
    && (state.project.status === 'needs_review' || state.project.status === 'completed');
  const exportHref = state.project.exportObjectKey
    ? `/api/projects/${encodeURIComponent(state.project.id)}/export/media`
    : undefined;

  const studioCommands = buildStudioCommands({
    canSplit,
    canUndo,
    canRedo,
    split: () => { void editorActions.splitSelected(); },
    undo: () => { void editorActions.undo(); },
    redo: () => { void editorActions.redo(); },
    zoomIn: () => dispatch({ type: 'setTimelineZoom', pixelsPerSecond: state.timelineView.pixelsPerSecond + 0.25 }),
    zoomOut: () => dispatch({ type: 'setTimelineZoom', pixelsPerSecond: state.timelineView.pixelsPerSecond - 0.25 }),
    openSources: () => setMobilePanel('sources'),
    openInspector: () => setMobilePanel('inspector'),
  });

  useEffect(() => {
    const handleStudioShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = resolveStudioShortcut(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        },
        {
          typing: isNativeTextUndoTarget(event.target),
          timelineFocused: isTimelineShortcutTarget(event.target),
          canUndo,
          canRedo,
          canSplit,
        },
      );
      if (!action) return;
      event.preventDefault();

      switch (action) {
        case 'open-commands':
          openCommandPalette();
          return;
        case 'undo':
          void editorActions.undo();
          return;
        case 'redo':
          void editorActions.redo();
          return;
        case 'split':
          void editorActions.splitSelected();
          return;
        case 'zoom-in':
          dispatch({ type: 'setTimelineZoom', pixelsPerSecond: state.timelineView.pixelsPerSecond + 0.25 });
          return;
        case 'zoom-out':
          dispatch({ type: 'setTimelineZoom', pixelsPerSecond: state.timelineView.pixelsPerSecond - 0.25 });
          return;
        case 'toggle-playback':
          dispatch({ type: 'setPlaying', playing: !state.playback.playing });
          return;
        case 'seek-back-small':
          dispatch({ type: 'setPlayhead', playheadMs: state.playheadMs - 1000 });
          return;
        case 'seek-forward-small':
          dispatch({ type: 'setPlayhead', playheadMs: state.playheadMs + 1000 });
          return;
        case 'seek-back-large':
          dispatch({ type: 'setPlayhead', playheadMs: state.playheadMs - 5000 });
          return;
        case 'seek-forward-large':
          dispatch({ type: 'setPlayhead', playheadMs: state.playheadMs + 5000 });
          return;
        case 'escape':
          closeCommandPalette();
          setMobilePanel('none');
          return;
      }
    };
    window.addEventListener('keydown', handleStudioShortcut);
    return () => window.removeEventListener('keydown', handleStudioShortcut);
  }, [
    canRedo,
    canSplit,
    canUndo,
    closeCommandPalette,
    dispatch,
    editorActions,
    openCommandPalette,
    state.playback.playing,
    state.playheadMs,
    state.timelineView.pixelsPerSecond,
  ]);

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
        canShare={Boolean(exportHref)}
        onShare={() => setShareOpen((value) => !value)}
        onExport={() => { void startFinalExport(); }}
        onUndo={() => { void editorActions.undo(); }}
        onRedo={() => { void editorActions.redo(); }}
        onOpenCommands={openCommandPalette}
        onOpenSources={() => toggleMobilePanel('sources')}
        onOpenInspector={() => toggleMobilePanel('inspector')}
      />

      {shareOpen && state.project.exportObjectKey ? (
        <SharePanel projectId={state.project.id} onClose={() => setShareOpen(false)} />
      ) : null}

      <CommandPalette open={commandPaletteOpen} commands={studioCommands} onClose={closeCommandPalette} />

      {cloudError && <div className="error-banner" role="alert">{cloudError}</div>}
      {editorError && <div className="error-banner editor-error-banner" role="alert">{editorError}</div>}

      <main className="studio-grid" aria-label="DubFlow dubbing workspace">
        <aside className="left-rail" aria-label="Nguồn media và nhân vật">
          <UploadPanel onProcessStarted={onProcessStarted} speakerSection={<SpeakerList speakers={state.project.speakers} selectedSpeakerId={selectedSpeaker?.id} />} />
          {cloudEditable && (
            <>
              <section className="panel translation-settings-host">
                <TargetLanguagesPanel
                  projectId={state.project.id}
                  currentLanguage={currentLanguage}
                  onCurrentLanguageChange={setCurrentLanguage}
                  selectedLanguages={selectedExportLanguages}
                  onSelectedLanguagesChange={setSelectedExportLanguages}
                />
              </section>
              <section className="panel translation-settings-host">
                <TranslationSettingsPanel projectId={state.project.id} />
              </section>
              <section className="panel translation-settings-host">
                <BatchExportPanel
                  projectId={state.project.id}
                  currentTargetLanguage={targetLanguage ?? 'vi'}
                  enabledLanguages={selectedExportLanguages.length ? selectedExportLanguages : ['vi']}
                  selectedLanguages={selectedExportLanguages}
                  onSelectedLanguagesChange={setSelectedExportLanguages}
                />
              </section>
            </>
          )}
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
          segment={selectedInspectorSegment}
          speakers={state.project.speakers}
          lipSyncEnabled={state.lipSyncEnabled}
          dispatch={dispatch}
          cloudEditable={cloudEditable}
          draft={targetEditing ? undefined : selectedDraft}
          onEditDraft={editInspectorDraft}
          onFlushDraft={(segmentId) => { void flushInspectorDraft(segmentId); }}
          onRetryDraft={(segmentId) => { void flushInspectorDraft(segmentId); }}
          onDiscardConflict={targetEditing ? undefined : autosave.discardConflict}
          onReapplyConflict={targetEditing ? undefined : (segmentId) => { void autosave.reapplyConflict(segmentId); }}
          translationMode={translationMode}
          onTranslationModeChange={setTranslationMode}
          onRetranslate={retranslate}
          comparison={translationComparison}
          onApplyTranslation={applyTranslation}
          busy={mutationLocked}
          error={editorError}
        />
      </main>

      <button type="button" className="mobile-panel-backdrop" aria-label="Đóng bảng phụ" onClick={() => setMobilePanel('none')} />

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