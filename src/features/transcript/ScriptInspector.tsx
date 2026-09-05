import type { Dispatch } from 'react';
import type { StudioAction } from '../../app/studioState';
import type { Segment, Speaker } from '../timeline/types';

type ScriptInspectorProps = {
  segment?: Segment;
  speakers: Speaker[];
  lipSyncEnabled: boolean;
  dispatch: Dispatch<StudioAction>;
};

export function ScriptInspector({ segment, speakers, lipSyncEnabled, dispatch }: ScriptInspectorProps) {
  if (!segment) {
    return <aside className="script-inspector" aria-label="Inspector dubbing">Chưa có phân đoạn.</aside>;
  }

  return (
    <aside className="script-inspector" aria-label="Inspector dubbing">
      <div className="inspector-title">
        <div><span className="eyebrow">EDITOR</span><h2>AI Dubbing Studio</h2></div>
        <span className="status-dot" title="Editor sẵn sàng">●</span>
      </div>

      <div className="inspector-tabs" role="tablist" aria-label="Chế độ inspector">
        <button className="is-active" type="button" role="tab" aria-selected="true">Kịch bản</button>
        <button type="button" role="tab" aria-selected="false">Nhân vật</button>
      </div>

      <div className="language-card language-card--source">
        <div className="language-card__head"><span>🇨🇳 中文 (原声)</span><time>00:15:23</time></div>
        <textarea
          aria-label="Lời thoại gốc"
          value={segment.sourceText}
          onChange={(event) => dispatch({ type: 'editSource', segmentId: segment.id, text: event.target.value })}
        />
        <div className="romanization">Nǐ zhōngyú láile, wǒ děng nǐ hěnjiǔle.</div>
      </div>

      <div className="swap-marker" aria-hidden="true">↻</div>

      <div className="language-card language-card--target">
        <div className="language-card__head"><span>🇻🇳 Tiếng Việt (Dubbing)</span><time>00:15:23</time></div>
        <textarea
          aria-label="Lời thoại dubbing tiếng Việt"
          value={segment.translatedText}
          onChange={(event) => dispatch({ type: 'editTranslation', segmentId: segment.id, text: event.target.value })}
        />
      </div>

      <div className="voice-section">
        <label htmlFor="speaker-assignment">Gán giọng cho nhân vật</label>
        <select
          id="speaker-assignment"
          value={segment.speakerId}
          onChange={(event) => dispatch({ type: 'assignSpeaker', segmentId: segment.id, speakerId: event.target.value })}
        >
          {speakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.name} · {speaker.label}</option>)}
        </select>
        <button className="secondary-button" type="button" disabled title="Provider giọng chưa được live-qualified">▷ Nghe thử giọng · Chưa cấu hình</button>
        <button className="ghost-button" type="button" disabled title="Provider giọng chưa được live-qualified">Tạo lại giọng · Chưa cấu hình</button>
      </div>

      <div className="toggle-row">
        <div>
          <strong>Đồng bộ khẩu hình</strong>
          <span>Duration fitting khả dụng; visual lip-sync chỉ bật khi capability backend xác nhận.</span>
        </div>
        <button
          className={`toggle ${lipSyncEnabled ? 'is-on' : ''}`}
          aria-label="Bật hoặc tắt đồng bộ khẩu hình"
          aria-pressed={lipSyncEnabled}
          type="button"
          onClick={() => dispatch({ type: 'toggleLipSync' })}
        ><i /></button>
      </div>
    </aside>
  );
}
