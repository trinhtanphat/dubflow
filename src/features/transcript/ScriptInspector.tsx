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
  if (!segment) return <aside className="script-inspector">Chưa có phân đoạn.</aside>;
  const commit = (patch: SegmentPatch) => { if (cloudEditable) onCommitPatch?.(segment.id, patch); };

  return (
    <aside className="script-inspector">
      <div className="inspector-title"><div><span className="eyebrow">EDITOR</span><h2>AI Dubbing Studio</h2></div><span className="status-dot">●</span></div>
      <div className="inspector-tabs"><button className="is-active" type="button">Kịch bản</button><button type="button">Nhân vật</button></div>

      <div className="language-card language-card--source">
        <div className="language-card__head"><span>🇨🇳 中文 (原声)</span><time>00:15:23</time></div>
        <textarea
          value={segment.sourceText}
          onChange={(event: any) => dispatch({ type: 'editSource', segmentId: segment.id, text: event.target.value })}
          onBlur={() => commit({ sourceText: segment.sourceText })}
        />
        <div className="romanization">Nǐ zhōngyú láile, wǒ děng nǐ hěnjiǔle.</div>
      </div>

      <div className="swap-marker">↻</div>

      <div className="language-card language-card--target">
        <div className="language-card__head"><span>🇻🇳 Tiếng Việt (Dubbing)</span><time>00:15:23</time></div>
        <textarea
          value={segment.translatedText}
          onChange={(event: any) => dispatch({ type: 'editTranslation', segmentId: segment.id, text: event.target.value })}
          onBlur={() => commit({ translatedText: segment.translatedText })}
        />
        {cloudEditable && (
          <div className="translation-controls">
            <select aria-label="Nhà cung cấp dịch" value={translationMode} onChange={(event: any) => onTranslationModeChange?.(event.target.value as TranslationMode)}>
              <option value="workers-ai">Workers AI</option>
              <option value="google">Google</option>
              <option value="compare">So sánh</option>
            </select>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => onRetranslate?.(segment.id)}>{busy ? 'Đang dịch…' : 'Dịch lại'}</button>
          </div>
        )}
        {comparison && (
          <div className="translation-compare" aria-label="So sánh bản dịch">
            <div><strong>Workers AI</strong><p>{comparison.workersAI}</p><button type="button" className="ghost-button" onClick={() => onApplyTranslation?.(comparison.workersAI)}>Áp dụng</button></div>
            <div><strong>Google</strong><p>{comparison.google}</p><button type="button" className="ghost-button" onClick={() => onApplyTranslation?.(comparison.google)}>Áp dụng</button></div>
          </div>
        )}
        {error && <p className="error-banner" role="alert">{error}</p>}
      </div>

      <div className="voice-section">
        <label htmlFor="speaker-assignment">Gán giọng cho nhân vật</label>
        <select id="speaker-assignment" value={segment.speakerId} onChange={(event: any) => {
          const speakerId = event.target.value;
          dispatch({ type: 'assignSpeaker', segmentId: segment.id, speakerId });
          commit({ speakerId });
        }}>{speakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.name} · {speaker.label}</option>)}</select>
        <button className="secondary-button" type="button" disabled>▷ Nghe thử giọng · Phase 2</button>
        <button className="ghost-button" type="button" disabled>Regenerate voice · Phase 2</button>
      </div>

      <div className="toggle-row"><div><strong>Đồng bộ khẩu hình</strong><span>V1 dùng duration fitting; visual lip-sync là subsystem tùy chọn.</span></div><button className={`toggle ${lipSyncEnabled ? 'is-on' : ''}`} aria-pressed={lipSyncEnabled} type="button" onClick={() => dispatch({ type: 'toggleLipSync' })}><i /></button></div>
    </aside>
  );
}
