import { useState } from 'react';
import { Cloud, Coins, Edit3, Globe2, Languages, Mic2, Sparkles, Upload, UserRound, Waves } from 'lucide-react';
import { UploadPanel } from '../features/upload/UploadPanel';
import { SpeakerList } from '../features/speakers/SpeakerList';
import { VideoStage } from '../features/player/VideoStage';
import { Timeline } from '../features/timeline/Timeline';
import { ScriptInspector } from '../features/transcript/ScriptInspector';
import { useStudioState } from './useStudioState';
import './app.css';

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const { state, selectedSegment, dispatch } = useStudioState();

  return (
    <div className="studio-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-wave"><i/><i/><i/><i/><i/><i/><i/></div><div><strong>DubFlow</strong><span>AI Studio Dubbing</span></div></div>
        <div className="project-name"><span>Dự án:</span><strong>{state.project.title}</strong><Edit3 size={14}/></div>
        <div className="topbar-spacer"/>
        <div className="cloud-mode"><Cloud size={19}/><div><strong>Cloud Mode</strong><span>24/7 Running</span></div></div>
        <div className="credits"><Coins size={20}/><div><strong>50,000 Credits</strong><span>Dùng thử miễn phí</span></div></div>
        <div className="profile-chip">YU</div>
        <button className="export-button" type="button"><Upload size={17}/> Xuất bản Dubbing</button>
      </header>

      <main className="workspace">
        <aside className="left-rail">
          <UploadPanel file={file} onFile={setFile}/>
          <SpeakerList speakers={state.project.speakers}/>
          <div className="language-controls">
            <label><span>Ngôn ngữ gốc</span><button type="button"><span className="flag flag-cn">★</span><strong>中文 (普通话)</strong><b>⌄</b></button></label>
            <label><span>Ngôn ngữ dịch</span><button type="button"><span className="flag flag-vi">★</span><strong>Tiếng Việt</strong><b>⌄</b></button></label>
          </div>
          <button className="dub-button" type="button"><Sparkles size={16}/> Bắt đầu Dubbing AI</button>
          <p className="dub-help">AI sẽ tự động dịch & lồng tiếng<br/>giữ nguyên cảm xúc & giọng nhân vật</p>
        </aside>

        <section className="center-stage" aria-label="Không gian biên tập chính">
          <VideoStage file={file} segment={selectedSegment} currentMs={state.playheadMs} durationMs={state.project.durationMs} playing={state.isPlaying} onTogglePlay={() => dispatch({ type: 'toggle-play' })}/>
          <Timeline durationMs={state.project.durationMs} playheadMs={state.playheadMs} speakers={state.project.speakers} segments={state.project.segments} selectedId={state.selectedSegmentId} onSelect={(id) => dispatch({ type: 'select', id })}/>
        </section>

        <ScriptInspector segment={selectedSegment} speakers={state.project.speakers} lipSync={state.lipSync} onLipSync={() => dispatch({ type: 'toggle-lip-sync' })} onSourceChange={(value) => dispatch({ type: 'edit-source', id: selectedSegment.id, value })} onTranslationChange={(value) => dispatch({ type: 'edit-translation', id: selectedSegment.id, value })}/>
      </main>

      <footer className="feature-strip">
        <div><Globe2/><span><strong>Dub mọi ngôn ngữ</strong><small>Tiếng Trung, Anh, Việt...</small></span></div>
        <div><UserRound/><span><strong>Tự nhận diện nhân vật</strong><small>AI phân tích giọng nói</small></span></div>
        <div><Waves/><span><strong>Tự clone voice nhân vật</strong><small>Sẵn sàng khi provider hỗ trợ</small></span></div>
        <div><Cloud/><span><strong>Chạy trên Cloud 24/7</strong><small>Không cần GPU, CPU</small></span></div>
        <div><Mic2/><span><strong>3,500+ voices</strong><small>Kiến trúc mở rộng giọng nói</small></span></div>
      </footer>
    </div>
  );
}
