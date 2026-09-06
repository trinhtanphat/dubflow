import { useEffect, useMemo, useState, type Dispatch } from 'react';
import {
  applySegmentFieldPatch,
  segmentFieldKeys,
  type SegmentDraft,
  type SegmentFieldPatch,
} from '../../app/autosaveDraft';
import type { StudioAction } from '../../app/studioState';
import { createVoicePreviewAction } from '../../app/voicePreviewAction';
import type { Segment, Speaker } from '../timeline/types';
import type { TranslationMode } from '../translation/translationApi';
import { fetchVoiceCapabilities, type VoiceCapabilities } from '../voice/voiceApi';
import { SegmentConflictNotice } from './SegmentConflictNotice';
import type { SegmentPatch } from './segmentApi';

type TranslationComparison = { workersAI: string; google: string };
export type InspectorTab = 'script' | 'characters' | 'voice' | 'ai';

export const INSPECTOR_TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'script', label: 'Kịch bản' },
  { id: 'characters', label: 'Nhân vật' },
  { id: 'voice', label: 'Giọng nói' },
  { id: 'ai', label: 'AI' },
];

type ScriptInspectorProps = {
  segment?: Segment;
  speakers: Speaker[];
  lipSyncEnabled: boolean;
  visualLipSyncAvailable?: boolean;
  dispatch: Dispatch<StudioAction>;
  cloudEditable?: boolean;
  draft?: SegmentDraft;
  onEditDraft?: (segmentId: string, patch: SegmentFieldPatch) => void;
  onFlushDraft?: (segmentId: string) => void;
  onRetryDraft?: (segmentId: string) => void;
  onDiscardConflict?: (segmentId: string) => void;
  onReapplyConflict?: (segmentId: string) => void;
  translationMode?: TranslationMode;
  onTranslationModeChange?: (mode: TranslationMode) => void;
  onCommitPatch?: (segmentId: string, patch: SegmentPatch) => void;
  onRetranslate?: (segmentId: string) => void;
  comparison?: TranslationComparison | null;
  onApplyTranslation?: (text: string) => void;
  busy?: boolean;
  error?: string;
  voiceConfigured?: boolean;
  voiceProviderLabel?: string;
  voiceBusy?: boolean;
  voiceError?: string;
  onPreviewVoice?: (text: string, voice?: string) => void;
};

function providerLabel(capabilities: VoiceCapabilities | null): string {
  if (capabilities?.provider === 'elevenlabs') return 'ElevenLabs';
  if (capabilities?.provider) return capabilities.provider;
  return 'Chưa cấu hình';
}

export function resolveSegmentSpeakerVoice(
  segment: Pick<Segment, 'speakerId'>,
  speakers: Speaker[],
): string | undefined {
  const speaker = speakers.find((candidate) => candidate.id === segment.speakerId);
  if (speaker?.voiceProvider !== 'elevenlabs') return undefined;
  const voiceId = speaker.voiceId?.trim();
  return voiceId || undefined;
}

export function ScriptInspector({
  segment,
  speakers,
  lipSyncEnabled,
  visualLipSyncAvailable = false,
  dispatch,
  cloudEditable = false,
  draft,
  onEditDraft,
  onFlushDraft,
  onRetryDraft,
  onDiscardConflict,
  onReapplyConflict,
  translationMode = 'workers-ai',
  onTranslationModeChange,
  onCommitPatch,
  onRetranslate,
  comparison,
  onApplyTranslation,
  busy = false,
  error = '',
  voiceConfigured,
  voiceProviderLabel,
  voiceBusy = false,
  voiceError = '',
  onPreviewVoice,
}: ScriptInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('script');
  const [detectedVoice, setDetectedVoice] = useState<VoiceCapabilities | null>(null);
  const [internalVoiceBusy, setInternalVoiceBusy] = useState(false);
  const [internalVoiceError, setInternalVoiceError] = useState('');

  useEffect(() => {
    if (voiceConfigured !== undefined) return;
    const controller = new AbortController();
    fetchVoiceCapabilities().then((capabilities) => {
      if (!controller.signal.aborted) setDetectedVoice(capabilities);
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setDetectedVoice(null);
        setInternalVoiceError(cause instanceof Error ? cause.message : 'Không thể kiểm tra provider giọng nói.');
      }
    });
    return () => controller.abort();
  }, [voiceConfigured]);

  const internalPreview = useMemo(() => createVoicePreviewAction({
    setBusy: setInternalVoiceBusy,
    setError: setInternalVoiceError,
  }), []);

  if (!segment) {
    return <aside className="script-inspector" aria-label="Inspector dubbing">Chưa có phân đoạn.</aside>;
  }

  const visibleSegment = draft ? applySegmentFieldPatch(segment, draft.patch) : segment;
  const effectiveVoiceConfigured = voiceConfigured ?? Boolean(detectedVoice?.configured && detectedVoice?.preview);
  const effectiveVoiceProvider = voiceProviderLabel ?? providerLabel(detectedVoice);
  const effectiveVoiceBusy = voiceBusy || internalVoiceBusy;
  const effectiveVoiceError = voiceError || internalVoiceError;
  const effectiveLipSyncEnabled = visualLipSyncAvailable && lipSyncEnabled;

  const commitLegacy = (patch: SegmentPatch) => {
    if (cloudEditable) onCommitPatch?.(segment.id, patch);
  };
  const editField = (patch: SegmentFieldPatch, legacy: StudioAction) => {
    if (cloudEditable && onEditDraft) onEditDraft(segment.id, patch);
    else dispatch(legacy);
  };
  const flushField = (legacyPatch: SegmentPatch) => {
    if (cloudEditable && onFlushDraft) onFlushDraft(segment.id);
    else commitLegacy(legacyPatch);
  };

  const previewEnabled = effectiveVoiceConfigured && !effectiveVoiceBusy && Boolean(visibleSegment.translatedText.trim());
  const selectedSpeaker = speakers.find((speaker) => speaker.id === visibleSegment.speakerId) ?? speakers[0];
  const selectedVoice = resolveSegmentSpeakerVoice(visibleSegment, speakers);
  const previewVoice = () => {
    if (!previewEnabled) return;
    const text = visibleSegment.translatedText.trim();
    if (onPreviewVoice) onPreviewVoice(text, selectedVoice);
    else void internalPreview(text, selectedVoice);
  };

  const assignSpeaker = (speakerId: string) => {
    if (cloudEditable && onEditDraft) {
      onEditDraft(segment.id, { speakerId });
      onFlushDraft?.(segment.id);
    } else {
      dispatch({ type: 'assignSpeaker', segmentId: segment.id, speakerId });
      commitLegacy({ speakerId });
    }
  };

  return (
    <aside className="script-inspector" aria-label="Inspector dubbing">
      <div className="inspector-title reference-inspector-header">
        <div><span className="eyebrow">EDITOR</span><h2>AI Dubbing Studio</h2></div>
        <span className="status-dot" title="Editor sẵn sàng">●</span>
      </div>

      <div className="inspector-tabs" role="tablist" aria-label="Chế độ inspector">
        {INSPECTOR_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`inspector-tab-${tab.id}`}
            className={activeTab === tab.id ? 'is-active' : ''}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`inspector-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
          >{tab.label}</button>
        ))}
      </div>

      <section
        id="inspector-panel-script"
        className="inspector-tab-panel inspector-tab-panel--script"
        role="tabpanel"
        aria-labelledby="inspector-tab-script"
        hidden={activeTab !== 'script'}
      >
        <div className="language-card language-card--source reference-script-card">
          <div className="language-card__head"><span>🇨🇳 中文 (原声)</span><time>00:15:23</time></div>
          <textarea
            aria-label="Lời thoại gốc"
            lang="zh-CN"
            value={visibleSegment.sourceText}
            onChange={(event) => editField(
              { sourceText: event.target.value },
              { type: 'editSource', segmentId: segment.id, text: event.target.value },
            )}
            onBlur={() => flushField({ sourceText: visibleSegment.sourceText })}
          />
          <div className="romanization">Nǐ zhōngyú láile, wǒ děng nǐ hěnjiǔle.</div>
        </div>

        <div className="swap-marker" aria-hidden="true">↻</div>

        <div className="language-card language-card--target reference-script-card">
          <div className="language-card__head"><span>🇻🇳 Tiếng Việt (Dubbing)</span><time>00:15:23</time></div>
          <textarea
            aria-label="Lời thoại dubbing tiếng Việt"
            value={visibleSegment.translatedText}
            onChange={(event) => editField(
              { translatedText: event.target.value },
              { type: 'editTranslation', segmentId: segment.id, text: event.target.value },
            )}
            onBlur={() => flushField({ translatedText: visibleSegment.translatedText })}
          />

          {error && <p className="error-banner" role="alert">{error}</p>}
          {draft?.phase === 'error' && (
            <div className="segment-save-error" role="alert">
              <p>{draft.error || 'Không thể lưu thay đổi.'}</p>
              <button type="button" className="ghost-button" onClick={() => onRetryDraft?.(segment.id)}>Thử lưu lại</button>
            </div>
          )}
          {draft?.phase === 'conflict' && draft.conflictingServer && (
            <SegmentConflictNotice
              local={visibleSegment}
              server={draft.conflictingServer}
              touchedFields={segmentFieldKeys(draft.patch)}
              onUseServer={() => onDiscardConflict?.(segment.id)}
              onReapply={() => onReapplyConflict?.(segment.id)}
            />
          )}
        </div>
      </section>

      <section
        id="inspector-panel-characters"
        className="inspector-tab-panel inspector-tab-panel--characters"
        role="tabpanel"
        aria-labelledby="inspector-tab-characters"
        hidden={activeTab !== 'characters'}
      >
        <div className="character-inspector-card reference-character-card">
          <span className="eyebrow">NHÂN VẬT ĐANG CHỌN</span>
          <strong>{selectedSpeaker?.name ?? 'Chưa nhận diện nhân vật'}</strong>
          <p>{selectedSpeaker?.label ?? 'Chưa có nhãn'} · {Math.round((selectedSpeaker?.share ?? 0) * ((selectedSpeaker?.share ?? 0) <= 1 ? 100 : 1))}% thời lượng</p>
          <small>Voice provider: {effectiveVoiceConfigured ? effectiveVoiceProvider : 'Chưa cấu hình'}</small>
        </div>
        <div className="voice-section character-assignment-section">
          <label htmlFor="speaker-assignment">Gán nhân vật cho phân đoạn</label>
          <select
            id="speaker-assignment"
            value={visibleSegment.speakerId}
            onChange={(event) => assignSpeaker(event.target.value)}
          >
            {speakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.name} · {speaker.label}</option>)}
          </select>
        </div>
      </section>

      <section
        id="inspector-panel-voice"
        className="inspector-tab-panel inspector-tab-panel--voice"
        role="tabpanel"
        aria-labelledby="inspector-tab-voice"
        hidden={activeTab !== 'voice'}
      >
        <div className="voice-section reference-voice-assignment">
          <strong>Gán giọng cho nhân vật</strong>
          <p className="voice-assignment-summary">
            {selectedSpeaker?.name ?? 'Nhân vật chưa xác định'} · {selectedVoice ? 'Đã gán voice riêng' : 'Dùng voice mặc định'}
          </p>
          <button
            className="secondary-button"
            type="button"
            disabled={!previewEnabled}
            title={effectiveVoiceConfigured ? `Tạo preview bằng ${effectiveVoiceProvider}${selectedVoice ? ' · giọng nhân vật đã gán' : ' · giọng mặc định'}` : 'Provider giọng chưa được cấu hình'}
            onClick={previewVoice}
          >{effectiveVoiceBusy ? 'Đang tạo giọng…' : `▷ Nghe thử giọng · ${effectiveVoiceConfigured ? effectiveVoiceProvider : 'Chưa cấu hình'}`}</button>
          <button
            className="ghost-button"
            type="button"
            disabled={!previewEnabled}
            title={effectiveVoiceConfigured ? 'Tạo lại preview từ lời thoại hiện tại' : 'Provider giọng chưa được cấu hình'}
            onClick={previewVoice}
          >Tạo lại giọng{effectiveVoiceConfigured ? '' : ' · Chưa cấu hình'}</button>
          {effectiveVoiceError && <p className="error-banner" role="alert">{effectiveVoiceError}</p>}
        </div>

        <div className="toggle-row">
          <div>
            <strong>Đồng bộ khẩu hình</strong>
            <span>
              {visualLipSyncAvailable
                ? 'Visual lip-sync đã được backend xác nhận; duration fitting vẫn được áp dụng.'
                : 'Visual lip-sync chưa khả dụng trên backend hiện tại.'}
            </span>
          </div>
          <button
            className={`toggle ${effectiveLipSyncEnabled ? 'is-on' : ''}`}
            disabled={!visualLipSyncAvailable}
            aria-label="Bật hoặc tắt đồng bộ khẩu hình"
            aria-pressed={effectiveLipSyncEnabled}
            type="button"
            onClick={() => {
              if (visualLipSyncAvailable) dispatch({ type: 'toggleLipSync' });
            }}
          ><i /></button>
        </div>
      </section>

      <section
        id="inspector-panel-ai"
        className="inspector-tab-panel inspector-tab-panel--ai"
        role="tabpanel"
        aria-labelledby="inspector-tab-ai"
        hidden={activeTab !== 'ai'}
      >
        {cloudEditable ? (
          <div className="translation-controls reference-translation-tools">
            <label className="translation-provider-field">
              <span className="eyebrow">NHÀ CUNG CẤP DỊCH</span>
              <select
                aria-label="Nhà cung cấp dịch"
                value={translationMode}
                onChange={(event) => onTranslationModeChange?.(event.target.value as TranslationMode)}
              >
                <option value="workers-ai">Workers AI</option>
                <option value="google">Google</option>
                <option value="compare">So sánh</option>
              </select>
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => onRetranslate?.(segment.id)}
            >{busy ? 'Đang dịch…' : 'Dịch lại'}</button>
          </div>
        ) : (
          <p className="inspector-capability-note">Dịch AI cloud sẽ khả dụng khi dự án được tải lên backend.</p>
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
      </section>
    </aside>
  );
}