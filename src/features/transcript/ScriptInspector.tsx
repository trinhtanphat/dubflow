import type { Dispatch } from 'react';
import type { StudioAction } from '../../app/studioState';
import type { Segment, Speaker } from '../timeline/types';
import type { SegmentPatch } from './segmentApi';
import type { TranslationMode } from '../translation/translationApi';

type TranslationComparison = { workersAI: string; google: string };

type ScriptInspectorProps = {
  segment?: Segment;
  speakers: Speaker[];
  lipSyncEnabled: boolean;
  dispatch: Dispatch<StudioAction>;
  cloudEditable?: boolean;
  translationMode?: TranslationMode;
  onTranslationModeChange?: (mode: TranslationMode) => void;
  onCommitPatch?: (segmentId: string, patch: SegmentPatch) => void;
  onRetranslate?: (segmentId: string) => void;
  comparison?: TranslationComparison | null;
  onApplyTranslation?: (text: string) => void;
  busy?: boolean;
  error?: string;
};

export function ScriptInspector({
  segment,
  speakers,
  lipSyncEnabled,
  dispatch,
  cloudEditable = false,
  translationMode = 'workers-ai',
  onTranslationModeChange,
  onCommitPatch,
  onRetranslate,
  comparison,
  onApplyTranslation,
  busy = false,
  error = '',
}: ScriptInspectorProps) {
  if (!segment) {
    return <aside className="script-inspector" aria-label="Inspector dubbing">Chưa có phân đoạn.</aside>;
  }

  const commit = (patch: SegmentPatch) => {
    if (cloudEditable) onCommitPatch?.(segment.id, patch);
  };

  return (
    <aside className="script-inspector" aria-label="Inspector dubbing">
      <div className="inspector-title">
        <div><span className="eyebrow">EDITOR</span><h2>AI Dubbing Studio</h2></div>
        <span className="status-dot" title="Editor sẵn sàng">●</span>
      </div>

      <div className="inspector-tabs" aria-label="Chế độ inspector">
        <button className="is-active" type="button" aria-current="page">Kịch bản</button>
        <button type="button" disabled title="Chế độ Nhân vật sẽ được kích hoạt trong Studio Pro V2.4">Nhân vật</button>
      </div>

      <div className="language-card language-card--source">
        <div className="language-card__head"><span>🇨🇳 中文 (原声)</span><time>00:15:23</time></div>
        <textarea
          aria-label="Lời thoại gốc"
          value={segment.sourceText}
          onChange={(event) => dispatch({ type: 'editSource', segmentId: segment.id, text: event.target.value })}
          onBlur={() => commit({ sourceText: segment.sourceText })}
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
          onBlur={() => commit({ translatedText: segment.translatedText })}
        />

        {cloudEditable && (
          <div className="translation-controls">
            <select
              aria-label="Nhà cung cấp dịch"
              value={translationMode}
              onChange={(event) => onTranslationModeChange?.(event.target.value as TranslationMode)}
            >
              <option value="workers-ai">Workers AI</option>
              <option value="google">Google</option>
              <option value="compare">So sánh</option>
            </select>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => onRetranslate?.(segment.id)}
            >{busy ? 'Đang dịch…' : 'Dịch lại'}</button>
          </div>
        )}

        {comparison && (
          <div className="translation-compare" aria-label="So sánh bản dịch">
            <div>
              <strong>Workers AI</strong>
              <p>{comparison.workersAI}</p>
              <button type="button" className="ghost-button" disabled={busy} onClick={() => onApplyTranslation?.(comparison.workersAI)}>Áp dụng</button>
            </div>
            <div>
              <strong>Google</strong>
              <p>{comparison.google}</p>
              <button type="button" className="ghost-button" disabled={busy} onClick={() => onApplyTranslation?.(comparison.google)}>Áp dụng</button>
            </div>
          </div>
        )}

        {error && <p className="error-banner" role="alert">{error}</p>}
      </div>

      <div className="voice-section">
        <label htmlFor="speaker-assignment">Gán giọng cho nhân vật</label>
        <select
          id="speaker-assignment"
          value={segment.speakerId}
          onChange={(event) => {
            const speakerId = event.target.value;
            dispatch({ type: 'assignSpeaker', segmentId: segment.id, speakerId });
            commit({ speakerId });
          }}
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
