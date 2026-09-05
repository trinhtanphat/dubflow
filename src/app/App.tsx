import { UploadPanel } from '../features/upload/UploadPanel';
import { SpeakerList } from '../features/speakers/SpeakerList';
import { VideoStage } from '../features/player/VideoStage';
import { ScriptInspector } from '../features/transcript/ScriptInspector';
import { Timeline } from '../features/timeline/Timeline';
import { useStudioState } from './useStudioState';

export function App() {
  const { state, dispatch, selectedSegment, selectedSpeaker } = useStudioState();
  return (
    <div className="app-shell studio-pro-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark" aria-hidden="true">◫</div><div><strong>YupVox</strong><span>AI Dubbing Studio</span></div></div>
        <div className="project-title"><span>Dự án:</span><strong>{state.project.title}</strong><button type="button" aria-label="Đổi tên dự án">✎</button></div>
        <div className="topbar-actions">
          <div className="cloud-badge"><span>☁</span><div><strong>Cloud Mode</strong><small>24/7 Ready</small></div></div>
          <div className="credits"><span>✦</span><div><strong>50,000 Credits</strong><small>Demo ledger</small></div></div>
          <div className="avatar">YV</div>
          <button className="export-button" type="button" disabled>⇧ Xuất bản Dubbing · Phase 2</button>
        </div>
      </header>

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
