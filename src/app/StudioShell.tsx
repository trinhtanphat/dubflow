import { UploadPanel } from '../features/upload/UploadPanel';
import { SpeakerList } from '../features/speakers/SpeakerList';
import { VideoStage } from '../features/player/VideoStage';
import { ScriptInspector } from '../features/transcript/ScriptInspector';
import { Timeline } from '../features/timeline/Timeline';
import type { useStudioState } from './useStudioState';
import { StudioTopbar } from './StudioTopbar';

type StudioShellProps = ReturnType<typeof useStudioState>;

export function StudioShell({ state, dispatch, selectedSegment, selectedSpeaker }: StudioShellProps) {
  return (
    <div className="app-shell studio-pro-shell">
      <StudioTopbar
        projectTitle={state.project.title}
        saveState="saved"
        cloudState="ready"
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
      />

      <main className="studio-grid" aria-label="DubFlow dubbing workspace">
        <aside className="left-rail">
          <UploadPanel />
          <SpeakerList speakers={state.project.speakers} selectedSpeakerId={selectedSpeaker?.id} />
        </aside>

        <section className="center-stage">
          <VideoStage segment={selectedSegment} playheadMs={state.playheadMs} durationMs={state.project.durationMs} />
          <Timeline project={state.project} playheadMs={state.playheadMs} selectedSegmentId={state.selectedSegmentId} dispatch={dispatch} />
        </section>

        <ScriptInspector segment={selectedSegment} speakers={state.project.speakers} lipSyncEnabled={state.lipSyncEnabled} dispatch={dispatch} />
      </main>

      <footer className="capability-strip">
        <span>🌐 Dub đa ngôn ngữ</span><span>♙ Tự nhận diện nhân vật</span><span>♬ Voice provider-ready</span><span>☁ Cloudflare-first</span><span>⌁ Workers AI + Google Translate</span>
      </footer>
    </div>
  );
}
