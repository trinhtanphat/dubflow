import { useEffect, useMemo, useState, type Dispatch } from 'react';
import type { StudioAction } from '../../app/studioState';
import { createVoicePreviewAction } from '../../app/voicePreviewAction';
import type { Segment, Speaker } from '../timeline/types';
import type { TranslationMode } from '../translation/translationApi';
import { fetchVoiceCapabilities, type VoiceCapabilities } from '../voice/voiceApi';
import type { SegmentPatch } from './segmentApi';

type TranslationComparison = { workersAI: string; google: string };
type InspectorTab = 'script' | 'characters';

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

  const effectiveVoiceConfigured = voiceConfigured ?? Boolean(detectedVoice?.configured && detectedVoice?.preview);
  const effectiveVoiceProvider = voiceProviderLabel ?? providerLabel(detectedVoice);
  const effectiveVoiceBusy = voiceBusy || internalVoiceBusy;
  const effectiveVoiceError = voiceError || internalVoiceError;

  const commit = (patch: SegmentPatch) => {
    if (cloudEditable) onCommitPatch?.(segment.id, patch);
  };
  const previewEnabled = effectiveVoiceConfigured && !effectiveVoiceBusy && Boolean(segment.translatedText.trim());
  const selectedSpeaker = speakers.find((speaker) => speaker.id === segment.speakerId) ?? speakers[0];
  const selectedVoice = resolveSegmentSpeakerVoice(segment, speakers);
  const previewVoice = () => {
    if (!previewEnabled) return;
    const text = segment.translatedText.trim();
    if (onPreviewVoice) onPreviewVoice(text, selectedVoice);
    else void internalPreview(text, selectedVoice);
  };

  return (
    <aside className="script-inspector" aria-label="Inspector dubbing">
      <div className="inspector-title reference-inspector-header">
        <div><span className="eyebrow">EDITOR</span><h2>AI Dubbing Studio</h2></div>
        <span className="status-dot" title="Editor sẵn sàng">●</span>
      </div>

      <div className="inspector-tabs" aria-label="Chế độ inspector">
        <button
          className={activeTab === 'script' ? 'is-active' : ''}
          type="button"
          aria-current={activeTab === 'script' ? 'page' : undefined}
          onClick={() => setActiveTab('script')}
        >Kịch bản</button>
        <button
          className={activeTab === 'characters' ? 'is-active' : ''}
          type="button"
          aria-current={activeTab === 'characters' ? 'page' : undefined}
          onClick={() => setActiveTab('characters')}
        >Nhân vật</button>
      </div>

      {activeTab === 'script' ? (
        <>
          <div className="language-card language-card--source reference-script-card">
            <div className="language-card__head"><span>🇨🇳 中文 (原声)</span><time>00:15:23</time></div>
            <textarea
              aria-label="Lời thoại gốc"
              lang="zh-CN"
              value={segment.sourceText}
              onChange={(event) => dispatch({ type: 'editSource', segmentId: segment.id, text: event.target.value })}
              onBlur={() => commit({ sourceText: segment.sourceText })}
            />
            <div className="romanization">Nǐ zhōngyú láile, wǒ děng nǐ hěnjiǔle.</div>
          </div>

          <div className="swap-marker" aria-hidden="true">↻</div>

          <div className="language-card language-card--target reference-script-card">
            <div className="language-card__head"><span>🇻🇳 Tiếng Việt (Dubbing)</span><time>00:15:23</time></div>
            <textarea
              aria-label="Lời thoại dubbing tiếng Việt"
              value={segment.translatedText}
              onChange={(event) => dispatch({ type: 'editTranslation', segmentId: segment.id, text: event.target.value })}
              onBlur={() => commit({ translatedText: segment.translatedText })}
            />

            {cloudEditable && (
              <div className="translation-controls reference-translation-tools">
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
        </>
      ) : (
        <div className="character-inspector-card reference-character-card">
          <span className="eyebrow">NHÂN VẬT ĐANG CHỌN</span>
          <strong>{selectedSpeaker?.name ?? 'Chưa nhận diện nhân vật'}</strong>
          <p>{selectedSpeaker?.label ?? 'Chưa có nhãn'} · {Math.round((selectedSpeaker?.share ?? 0) * ((selectedSpeaker?.share ?? 0) <= 1 ? 100 : 1))}% thời lượng</p>
          <small>Voice provider: {effectiveVoiceConfigured ? effectiveVoiceProvider : 'Chưa cấu hình'}</small>
        </div>
      )}

      <div className="voice-section reference-voice-assignment">
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
