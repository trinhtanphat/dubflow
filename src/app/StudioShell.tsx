import { useState } from 'react';
import { UploadPanel } from '../features/upload/UploadPanel';
import { SpeakerList } from '../features/speakers/SpeakerList';
import { VideoStage } from '../features/player/VideoStage';
import { ScriptInspector } from '../features/transcript/ScriptInspector';
import { Timeline } from '../features/timeline/Timeline';
import type { useStudioState } from './useStudioState';
import { StudioTopbar } from './StudioTopbar';

type StudioShellProps = ReturnType<typeof useStudioState>;
type MobilePanel = 'none' | 'sources' | 'inspector';

export function StudioShell({ state, dispatch, selectedSegment, selectedSpeaker }: StudioShellProps) {
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');
  const toggleMobilePanel = (panel: Exclude<MobilePanel, 'none'>) => {
    setMobilePanel((current) => current === panel ? 'none' : panel);
  };

  return (
    <div className={`app-shell studio-pro-shell mobile-panel--${mobilePanel}`}>
      <StudioTopbar
        projectTitle={state.project.title}
        saveState="saved"
        cloudState="ready"
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
        onOpenSources={() => toggleMobilePanel('sources')}
        onOpenInspector={() => toggleMobilePanel('inspector')}
      />

      <main className="studio-grid" aria-label="DubFlow dubbing workspace">
        <aside className="left-rail" aria-label="Nguồn media và nhân vật">
          <UploadPanel />
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
