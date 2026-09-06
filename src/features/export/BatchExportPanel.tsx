import type { VoiceCapabilities } from '../voice/voiceApi';
import type { TargetLanguage } from '../translation/languageVariantsApi';
import { LANGUAGE_LABELS } from '../translation/TargetLanguagesPanel';
import type {
  ExportCapabilitiesDto,
  ExportLaunchDto,
  ExportOutput,
  SeparationMode,
} from './batchExportApi';
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
  separationMode: SeparationMode;
  exportCapabilities: ExportCapabilitiesDto | null;
  voiceCapabilities: VoiceCapabilities | null;
  busy: boolean;
  results: ExportLaunchDto[];
  error: string;
  onOutputChange: (output: ExportOutput) => void;
  onSeparationModeChange: (mode: SeparationMode) => void;
  onToggleLanguage: (language: TargetLanguage) => void;
  onExportCurrent: () => void;
  onBatchExport: () => void;
  onRetryFailed: (language: TargetLanguage) => void;
};

function statusLabel(result: ExportLaunchDto) {
  return result.status === 'queued' ? 'Đã xếp hàng' : 'Thất bại';
}

export function BatchExportPanelView({
  currentTargetLanguage,
  enabledLanguages,
  selectedLanguages,
  output,
  separationMode,
  exportCapabilities,
  voiceCapabilities,
  busy,
  results,
  error,
  onOutputChange,
  onSeparationModeChange,
  onToggleLanguage,
  onExportCurrent,
  onBatchExport,
  onRetryFailed,
}: Props) {
  const voice = dubbedAvailability(voiceCapabilities, currentTargetLanguage);
  const separation = exportCapabilities?.dialogueBackgroundSeparation;
  const preserveAvailable = Boolean(
    separation?.available && separation.modes.includes('preserve_background'),
  );
  const separationBlocked = output === 'dubbed' && separationMode === 'preserve_background' && !preserveAvailable;
  const currentBlocked = output === 'dubbed' && (!voice.allowed || separationBlocked);
  const selectedBlocked = output === 'dubbed' && (
    separationBlocked || selectedLanguages.some((language) => !dubbedAvailability(voiceCapabilities, language).allowed)
  );
  const allSucceeded = results.length > 0 && results.every((result) => result.status === 'queued');

  return (
    <section className="batch-export" data-testid="batch-export-panel" aria-label="Batch export">
      <header className="batch-export__head">
        <strong>Multi-language Export</strong>
        <select aria-label="Đầu ra export" value={output} onChange={(event) => onOutputChange(event.currentTarget.value as ExportOutput)}>
          <option value="dubbed">Dubbed video</option>
          <option value="subtitles">Subtitles (.srt)</option>
        </select>
      </header>
      {output === 'dubbed' && (
        <fieldset className="batch-export__separation">
          <legend>Audio bed</legend>
          <label>
            <input
              type="radio"
              name="separation-mode"
              value="source_mix"
              checked={separationMode === 'source_mix'}
              onChange={() => onSeparationModeChange('source_mix')}
            />
            <span><strong>Source mix</strong><small>Giữ hành vi export an toàn mặc định.</small></span>
          </label>
          <label>
            <input
              type="radio"
              name="separation-mode"
              value="preserve_background"
              checked={separationMode === 'preserve_background'}
              disabled={!preserveAvailable}
              onChange={() => onSeparationModeChange('preserve_background')}
            />
            <span><strong>Preserve background/music</strong><small>Tách thoại và dùng background stem làm nền audio.</small></span>
          </label>
          {!preserveAvailable && (
            <p className="batch-export__guard">Tách thoại/background hiện không khả dụng trên deployment này.</p>
          )}
        </fieldset>
      )}
      <div className="batch-export__languages">
        {enabledLanguages.map((language) => (
          <label key={language}>
            <input type="checkbox" checked={selectedLanguages.includes(language)} onChange={() => onToggleLanguage(language)} />
            {LANGUAGE_LABELS[language]}
          </label>
        ))}
      </div>
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
