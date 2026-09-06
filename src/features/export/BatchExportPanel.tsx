import type { VoiceCapabilities } from '../voice/voiceApi';
import type { TargetLanguage } from '../translation/languageVariantsApi';
import { LANGUAGE_LABELS } from '../translation/TargetLanguagesPanel';
import type {
  DubbedAudioMode,
  ExportCapabilitiesDto,
  ExportLaunchDto,
  ExportOutput,
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

export function separatedBackgroundAvailability(
  capabilities: ExportCapabilitiesDto | null,
): { allowed: boolean; reason: string } {
  const separation = capabilities?.separation;
  if (!separation) return { allowed: false, reason: 'Separated background chưa khả dụng.' };
  if (
    separation.configured !== true
    || separation.qualification !== 'qualified'
    || separation.backgroundStem !== true
    || typeof separation.provider !== 'string'
    || separation.provider.trim() === ''
  ) {
    return { allowed: false, reason: 'Separated background chưa được xác nhận (unavailable/unqualified).' };
  }
  return { allowed: true, reason: '' };
}

type Props = {
  currentTargetLanguage: TargetLanguage;
  enabledLanguages: TargetLanguage[];
  selectedLanguages: TargetLanguage[];
  output: ExportOutput;
  audioMode: DubbedAudioMode;
  exportCapabilities: ExportCapabilitiesDto | null;
  voiceCapabilities: VoiceCapabilities | null;
  busy: boolean;
  results: ExportLaunchDto[];
  error: string;
  onOutputChange: (output: ExportOutput) => void;
  onAudioModeChange: (audioMode: DubbedAudioMode) => void;
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
  audioMode,
  exportCapabilities,
  voiceCapabilities,
  busy,
  results,
  error,
  onOutputChange,
  onAudioModeChange,
  onToggleLanguage,
  onExportCurrent,
  onBatchExport,
  onRetryFailed,
}: Props) {
  const voice = dubbedAvailability(voiceCapabilities, currentTargetLanguage);
  const separated = separatedBackgroundAvailability(exportCapabilities);
  const treatmentBlocked = output === 'dubbed' && audioMode === 'separated_background' && !separated.allowed;
  const currentBlocked = output === 'dubbed' && (!voice.allowed || treatmentBlocked);
  const selectedBlocked = output === 'dubbed' && (
    treatmentBlocked
    || selectedLanguages.some((language) => !dubbedAvailability(voiceCapabilities, language).allowed)
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
        <div className="batch-export__audio-treatment">
          <label>
            <span>Xử lý âm thanh</span>
            <select
              aria-label="Xử lý âm thanh"
              value={audioMode}
              onChange={(event) => onAudioModeChange(event.currentTarget.value as DubbedAudioMode)}
            >
              <option value="dubbed_only">Dubbed voice only</option>
              <option value="duck_original">Keep original ambience (duck dialogue)</option>
              <option value="separated_background" disabled={!separated.allowed}>Separated background stem</option>
            </select>
          </label>
          {!separated.allowed && <p className="batch-export__capability">{separated.reason}</p>}
        </div>
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
      {treatmentBlocked && <p className="batch-export__guard">{separated.reason}</p>}
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
