import { Play, RefreshCcw } from 'lucide-react';
import type { Segment, Speaker } from '../timeline/types';

type Props = {
  segment: Segment;
  speakers: Speaker[];
  lipSync: boolean;
  onLipSync: () => void;
  onSourceChange: (value: string) => void;
  onTranslationChange: (value: string) => void;
};

export function ScriptInspector({ segment, speakers, lipSync, onLipSync, onSourceChange, onTranslationChange }: Props) {
  const speaker = speakers.find((item) => item.id === segment.speakerId) ?? speakers[0];
  return (
    <aside className="right-rail" aria-label="AI Dubbing Studio">
      <div className="inspector-header"><strong>AI Dubbing Studio</strong><span>Dịch & lồng tiếng với AI</span></div>
      <div className="inspector-tabs"><button className="active" type="button">Kịch bản</button><button type="button">Nhân vật</button></div>
      <div className="script-card source-card">
        <div className="script-lang"><span className="flag flag-cn">★</span><strong>中文 (原声)</strong></div>
        <div className="script-time">00:15:23</div>
        <textarea aria-label="Kịch bản gốc" value={segment.sourceText} onChange={(event) => onSourceChange(event.target.value)} />
        <div className="romanization">Nǐ zhōngyú láile, wǒ děng nǐ hěnjiǔle.</div>
        <button className="round-play" type="button" aria-label="Phát bản gốc"><Play size={15} fill="currentColor"/></button>
      </div>
      <div className="swap-row"><span/><RefreshCcw size={16}/><span/></div>
      <div className="script-card translated-card">
        <div className="script-lang"><span className="flag flag-vi">★</span><strong>Tiếng Việt (Dubbing)</strong></div>
        <div className="script-time">00:15:23</div>
        <textarea aria-label="Bản dịch tiếng Việt" value={segment.translatedText} onChange={(event) => onTranslationChange(event.target.value)} />
        <button className="round-play" type="button" aria-label="Phát bản dịch"><Play size={15} fill="currentColor"/></button>
      </div>
      <div className="voice-assignment">
        <div className="rail-heading">Gán giọng cho nhân vật</div>
        <button className="voice-select" type="button"><span className={`avatar small avatar-${speaker.accent}`}>{speaker.initials}</span><span>{speaker.name} ({speaker.gender}主)</span><span>⌄</span></button>
        <button className="voice-preview" type="button" disabled title="Sẽ bật khi voice provider được cấu hình"><Play size={15} fill="currentColor"/> Nghe thử giọng</button>
      </div>
      <div className="lip-row"><div><strong>Đồng bộ khẩu hình</strong><span>Tự động khớp môi với giọng lồng tiếng</span></div><button className={`toggle ${lipSync ? 'on' : ''}`} type="button" onClick={onLipSync} aria-pressed={lipSync}><i /></button></div>
    </aside>
  );
}
