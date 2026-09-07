import type { VoiceCapabilities } from '../voice/voiceApi';
import type { TargetLanguage } from '../translation/languageVariantsApi';
import { LANGUAGE_LABELS } from '../translation/TargetLanguagesPanel';
import type { DubbedMixMode, ExportLaunchDto, ExportOutput } from './batchExportApi';
import type { SeparationStateDto } from './separationApi';
import './batch-export.css';

export function dubbedAvailability(
  capabilities: VoiceCapabilities | null,
  targetLanguage: TargetLanguage,
): { allowed: boolean; reason: string } {
  if (!capabilities?.configured) return { allowed: false, reason: 'Provider giọng chưa được cấu hình.' };
  if (capabilities.languages === 'unknown') return { allowed: false, reason: 'Khả năng giọng cho ngôn ngữ này chưa xác nhận (unqualified).' };
  if (!capabilities.languages.includes(targetLanguage)) return { allowed: false, reason: 'Provider giọng không hỗ trợ ngôn ngữ này.' };
  return { allowed: true, reason: '' };
}

type Props = {
  currentTargetLanguage: TargetLanguage;
  enabledLanguages: TargetLanguage[];
  selectedLanguages: TargetLanguage[];
  output: ExportOutput;
  voiceCapabilities: VoiceCapabilities | null;
  busy: boolean;
  results: ExportLaunchDto[];
  error: string;
  mixMode?: DubbedMixMode;
  separationState?: SeparationStateDto;
  separationBusy?: boolean;
  separationError?: string;
  onOutputChange: (output: ExportOutput) => void;
  onToggleLanguage: (language: TargetLanguage) => void;
  onExportCurrent: () => void;
  onBatchExport: () => void;
  onRetryFailed: (language: TargetLanguage) => void;
  onMixModeChange?: (mode: DubbedMixMode) => void;
  onPrepareBackground?: (retry: boolean) => void;
};

function statusLabel(result: ExportLaunchDto) {
  return result.status === 'queued' ? 'Đã xếp hàng' : 'Thất bại';
}

function separationLabel(state: SeparationStateDto) {
  if (state.status === 'completed') return 'Ready';
  if (state.status === 'queued' || state.status === 'running' || state.status === 'retrying') return 'Processing';
  if (state.status === 'failed') return 'Failed';
  if (state.status === 'invalidated') return 'Stale';
  return 'Not prepared';
}

const DEFAULT_SEPARATION: SeparationStateDto = {
  status: 'not_prepared',
  qualified: false,
  separation: null,
};

export function BatchExportPanelView({
  currentTargetLanguage,
  enabledLanguages,
  selectedLanguages,
  output,
  voiceCapabilities,
  busy,
  results,
  error,
  mixMode = 'dubbed_only',
  separationState = DEFAULT_SEPARATION,
  separationBusy = false,
  separationError = '',
  onOutputChange,
  onToggleLanguage,
  onExportCurrent,
  onBatchExport,
  onRetryFailed,
  onMixModeChange,
  onPrepareBackground,
}: Props) {
  const voice = dubbedAvailability(voiceCapabilities, currentTargetLanguage);
  const canPreserve = separationState.qualified && separationState.status === 'completed';
  const currentBlocked = output === 'dubbed' && (!voice.allowed || (mixMode === 'preserve_background' && !canPreserve));
  const selectedBlocked = output === 'dubbed' && (
    selectedLanguages.some((language) => !dubbedAvailability(voiceCapabilities, language).allowed)
    || (mixMode === 'preserve_background' && !canPreserve)
  );
  const allSucceeded = results.length > 0 && results.every((result) => result.status === 'queued');
  const lifecycle = separationLabel(separationState);
  const retry = separationState.status === 'failed';
  const showPrepare = separationState.status === 'not_prepared' || retry;

  return (
    <section className="batch-export" data-testid="batch-export-panel" aria-label="Batch export">
      <header className="batch-export__head">
        <strong>Multi-language Export</strong>
        <select aria-label="Đầu ra export" value={output} onChange={(event) => onOutputChange(event.currentTarget.value as ExportOutput)}>
          <option value="dubbed">Dubbed video</option>
          <option value="subtitles">Subtitles (.srt)</option>
        </select>
      </header>
      <div className="batch-export__languages">
        {enabledLanguages.map((language) => (
          <label key={language}>
            <input type="checkbox" checked={selectedLanguages.includes(language)} onChange={() => onToggleLanguage(language)} />
            {LANGUAGE_LABELS[language]}
          </label>
        ))}
      </div>
      {output === 'dubbed' && (
        <div className="batch-export__audio-treatment" aria-label="Audio treatment">
          <div className="batch-export__audio-head">
            <strong>Audio treatment</strong>
            <span className={`batch-export__separation-status is-${separationState.status}`}>{lifecycle}</span>
          </div>
          <label>
            <input
              type="radio"
              name="dubbed-mix-mode"
              value="dubbed_only"
              checked={mixMode === 'dubbed_only'}
              onChange={() => onMixModeChange?.('dubbed_only')}
            />
            Dubbed voices only
          </label>
          <label>
            <input
              type="radio"
              name="dubbed-mix-mode"
              value="preserve_background"
              checked={mixMode === 'preserve_background'}
              disabled={!canPreserve}
              onChange={() => onMixModeChange?.('preserve_background')}
            />
            Preserve music &amp; ambience
            <small>Preview</small>
          </label>
          {!separationState.qualified && <p className="batch-export__qualification">Unqualified preview — chưa có xác nhận chất lượng production.</p>}
          {showPrepare && (
            <button
              type="button"
              className="ghost-button batch-export__prepare"
              disabled={separationBusy || !separationState.qualified || !onPrepareBackground}
              onClick={() => onPrepareBackground?.(retry)}
            >
              {retry ? 'Retry background' : 'Prepare background'}
            </button>
          )}
          {separationState.status === 'failed' && separationState.separation?.errorMessage && (
            <p className="batch-export__separation-error">{separationState.separation.errorMessage}</p>
          )}
          {separationError && <p className="batch-export__separation-error" role="alert">{separationError}</p>}
        </div>
      )}
      {output === 'dubbed' && !voice.allowed && <p className="batch-export__guard">{voice.reason}</p>}
      <div className="batch-export__actions">
        <button type="button" className="secondary-button" data-testid="export-current-language" disabled={busy || currentBlocked} onClick={onExportCurrent}>
          Export current language
        </button>
        <button type="button" className="primary-button" disabled={busy || selectedLanguages.length === 0 || selectedBlocked} onClick={onBatchExport}>
          Batch export selected languages
        </button>
      </div>
      <div className="batch-export__results" aria-live="polite">
        {results.map((result) => (
          <div key={`${result.targetLanguage}:${result.exportId}`} className={`batch-export__result is-${result.status}`}>
            <span>{LANGUAGE_LABELS[result.targetLanguage]}</span>
            <strong>{statusLabel(result)}</strong>
            {result.status === 'failed' && (
              <button type="button" className="ghost-button" disabled={busy} onClick={() => onRetryFailed(result.targetLanguage)}>Thử lại</button>
            )}
          </div>
        ))}
      </div>
      {allSucceeded && <p className="batch-export__success">Tất cả ngôn ngữ đã xuất thành công.</p>}
      {error && <p className="batch-export__error" role="alert">{error}</p>}
    </section>
  );
}
