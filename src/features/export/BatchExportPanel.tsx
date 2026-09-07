import type { VoiceCapabilities } from '../voice/voiceApi';
import type { ClientVoicePreloadState } from '../voice/clientVoicePreload';
import type { TargetLanguage } from '../translation/languageVariantsApi';
import { LANGUAGE_LABELS } from '../translation/TargetLanguagesPanel';
import {
  exportMediaUrl,
  visualExportMediaUrl,
  type DubbedAudioMode,
  type ExportAttemptDto,
  type ExportCapabilitiesDto,
  type ExportLaunchDto,
  type ExportOutput,
  type LipSyncStatus,
  type VisualMode,
} from './batchExportApi';
import './batch-export.css';

export function dubbedAvailability(
  capabilities: VoiceCapabilities | null,
  targetLanguage: TargetLanguage,
  localVietnameseSupported = false,
): { allowed: boolean; reason: string } {
  if (targetLanguage === 'vi') {
    return localVietnameseSupported
      ? { allowed: true, reason: '' }
      : { allowed: false, reason: 'Trình duyệt này chưa hỗ trợ giọng Việt cục bộ.' };
  }
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

export function visualLipSyncAvailability(
  capabilities: ExportCapabilitiesDto | null,
): { allowed: boolean; reason: string } {
  const visual = capabilities?.visualLipSync;
  if (
    visual?.qualification === 'unqualified'
    && typeof visual.provider === 'string'
    && visual.provider.trim() !== ''
  ) {
    return {
      allowed: false,
      reason: 'Visual lip-sync đã cấu hình nhưng runtime chưa được xác nhận (unqualified).',
    };
  }
  if (
    visual?.available !== true
    || visual.qualification !== 'qualified'
    || typeof visual.provider !== 'string'
    || visual.provider.trim() === ''
  ) {
    return { allowed: false, reason: 'Visual lip-sync chưa khả dụng vì provider chưa được cấu hình.' };
  }
  return { allowed: true, reason: '' };
}

type AttemptView = Partial<Pick<
  ExportAttemptDto,
  'status' | 'exportObjectKey' | 'lipSyncRequested' | 'lipSyncStatus' | 'lipSyncObjectKey'
>>;

type Props = {
  projectId?: string;
  currentTargetLanguage: TargetLanguage;
  enabledLanguages: TargetLanguage[];
  selectedLanguages: TargetLanguage[];
  output: ExportOutput;
  audioMode: DubbedAudioMode;
  visualMode?: VisualMode;
  exportCapabilities: ExportCapabilitiesDto | null;
  voiceCapabilities: VoiceCapabilities | null;
  clientVoicePreloadState?: ClientVoicePreloadState;
  localVietnameseSupported?: boolean;
  busy: boolean;
  results: ExportLaunchDto[];
  attempts?: Partial<Record<TargetLanguage, AttemptView>>;
  error: string;
  onOutputChange: (output: ExportOutput) => void;
  onAudioModeChange: (audioMode: DubbedAudioMode) => void;
  onVisualModeChange?: (visualMode: VisualMode) => void;
  onToggleLanguage: (language: TargetLanguage) => void;
  onExportCurrent: () => void;
  onBatchExport: () => void;
  onRetryFailed: (language: TargetLanguage) => void;
};

function visualStatus(result: ExportLaunchDto, attempt?: AttemptView): LipSyncStatus | null {
  const explicit = attempt?.lipSyncStatus ?? result.lipSyncStatus;
  if (explicit && explicit !== 'not_requested') return explicit;
  const requested = attempt?.lipSyncRequested === true || result.lipSyncRequested === true || result.visualMode === 'lip_sync';
  if (!requested || result.status === 'failed') return null;
  if (result.status === 'completed') return 'completed';
  if (result.status === 'processing') return 'processing';
  return 'queued';
}

function statusLabel(result: ExportLaunchDto, attempt?: AttemptView) {
  const lipStatus = visualStatus(result, attempt);
  if (lipStatus === 'queued') return 'Lip-sync đã xếp hàng';
  if (lipStatus === 'processing') return 'Đang xử lý lip-sync';
  if (lipStatus === 'failed') return 'Lip-sync thất bại';
  if (lipStatus === 'completed') return 'Lip-sync hoàn tất';
  if (result.status === 'completed' || attempt?.status === 'completed') return 'Hoàn tất';
  if (result.status === 'processing') return 'Đang xử lý';
  if (result.status === 'queued') return 'Đã xếp hàng';
  return 'Thất bại';
}

function isCompleted(result: ExportLaunchDto, attempt?: AttemptView) {
  const lipStatus = visualStatus(result, attempt);
  if (lipStatus) return lipStatus === 'completed';
  return result.status === 'completed' || attempt?.status === 'completed';
}

function preloadLabel(state?: ClientVoicePreloadState): string {
  if (!state || state.phase === 'idle' || state.phase === 'failed') return '';
  if (state.phase === 'loading_model') {
    return state.percent === null
      ? 'Đang tải giọng Việt cục bộ…'
      : `Đang tải giọng Việt cục bộ: ${state.percent}%`;
  }
  if (state.phase === 'synthesizing' || state.phase === 'uploading') {
    return `Đang chuẩn bị giọng Việt ${Math.min(state.total, state.completed + 1)}/${state.total}`;
  }
  if (state.phase === 'verifying') return `Đang xác minh voice cache ${state.total}/${state.total}`;
  return 'Giọng Việt cục bộ đã sẵn sàng.';
}

export function BatchExportPanelView({
  projectId = '',
  currentTargetLanguage,
  enabledLanguages,
  selectedLanguages,
  output,
  audioMode,
  visualMode = 'standard',
  exportCapabilities,
  voiceCapabilities,
  clientVoicePreloadState,
  localVietnameseSupported = false,
  busy,
  results,
  attempts = {},
  error,
  onOutputChange,
  onAudioModeChange,
  onVisualModeChange = () => {},
  onToggleLanguage,
  onExportCurrent,
  onBatchExport,
  onRetryFailed,
}: Props) {
  const voice = dubbedAvailability(voiceCapabilities, currentTargetLanguage, localVietnameseSupported);
  const separated = separatedBackgroundAvailability(exportCapabilities);
  const visual = visualLipSyncAvailability(exportCapabilities);
  const treatmentBlocked = output === 'dubbed' && audioMode === 'separated_background' && !separated.allowed;
  const visualBlocked = output === 'dubbed' && visualMode === 'lip_sync' && !visual.allowed;
  const currentBlocked = output === 'dubbed' && (!voice.allowed || treatmentBlocked || visualBlocked);
  const selectedBlocked = output === 'dubbed' && (
    treatmentBlocked
    || visualBlocked
    || selectedLanguages.some((language) => !dubbedAvailability(voiceCapabilities, language, localVietnameseSupported).allowed)
  );
  const allSucceeded = results.length > 0 && results.every((result) => isCompleted(result, attempts[result.targetLanguage]));
  const localProgress = preloadLabel(clientVoicePreloadState);

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
        <>
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
          <div className="batch-export__visual-treatment">
            <label>
              <span>Xử lý hình ảnh</span>
              <select
                aria-label="Xử lý hình ảnh"
                value={visualMode}
                onChange={(event) => onVisualModeChange(event.currentTarget.value as VisualMode)}
              >
                <option value="standard">Standard dubbed video</option>
                <option value="lip_sync" disabled={!visual.allowed}>Visual lip-sync</option>
              </select>
            </label>
            {!visual.allowed && <p className="batch-export__capability">{visual.reason}</p>}
          </div>
          {localProgress && <p className="batch-export__capability" aria-live="polite">{localProgress}</p>}
        </>
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
      {visualBlocked && <p className="batch-export__guard">{visual.reason}</p>}
      <div className="batch-export__actions">
        <button type="button" className="secondary-button" data-testid="export-current-language" disabled={busy || currentBlocked} onClick={onExportCurrent}>
          Export current language
        </button>
        <button type="button" className="primary-button" disabled={busy || selectedLanguages.length === 0 || selectedBlocked} onClick={onBatchExport}>
          Batch export selected languages
        </button>
      </div>
      <div className="batch-export__results" aria-live="polite">
        {results.map((result) => {
          const attempt = attempts[result.targetLanguage];
          const lipStatus = visualStatus(result, attempt);
          const standardObjectKey = attempt?.exportObjectKey ?? result.exportObjectKey ?? null;
          const visualObjectKey = attempt?.lipSyncObjectKey ?? result.lipSyncObjectKey ?? null;
          const visualFailed = lipStatus === 'failed';
          const visualCompleted = lipStatus === 'completed' && Boolean(visualObjectKey);
          return (
            <div key={`${result.targetLanguage}:${result.exportId}`} className={`batch-export__result is-${visualFailed ? 'failed' : result.status}`}>
              <span>{LANGUAGE_LABELS[result.targetLanguage]}</span>
              <strong>{statusLabel(result, attempt)}</strong>
              {(result.status === 'failed' || visualFailed) && (
                <button type="button" className="ghost-button" disabled={busy} onClick={() => onRetryFailed(result.targetLanguage)}>
                  {visualFailed ? 'Thử lại lip-sync' : 'Thử lại'}
                </button>
              )}
              {visualFailed && standardObjectKey && projectId && (
                <a className="batch-export__fallback-link" href={exportMediaUrl(projectId, result.targetLanguage, 'dubbed')}>
                  Tải video dubbed chuẩn
                </a>
              )}
              {visualCompleted && projectId && (
                <a className="batch-export__visual-link" href={visualExportMediaUrl(projectId, result.targetLanguage)}>
                  Tải video lip-sync
                </a>
              )}
            </div>
          );
        })}
      </div>
      {allSucceeded && <p className="batch-export__success">Tất cả ngôn ngữ đã xuất thành công.</p>}
      {error && <p className="batch-export__error" role="alert">{error}</p>}
    </section>
  );
}
