import { useEffect, useState } from 'react';
import { fetchVoiceCapabilities, type VoiceCapabilities } from '../voice/voiceApi';
import { LANGUAGE_LABELS } from '../translation/TargetLanguagesPanel';
import type { TargetLanguage } from '../translation/languageVariantsApi';
import {
  startBatchExport,
  startLanguageExport,
  type ExportLaunchDto,
  type ExportOutput,
} from './batchExportApi';
import './batch-export.css';

export function dubbedAvailability(capabilities: VoiceCapabilities, targetLanguage: TargetLanguage) {
  if (capabilities.configured === false) {
    return { allowed: false, reason: 'Voice provider chưa được cấu hình.' };
  }
  if (capabilities.languages === 'unknown') {
    return { allowed: false, reason: `Voice capability cho ${LANGUAGE_LABELS[targetLanguage]} chưa xác nhận.` };
  }
  if (!capabilities.languages.includes(targetLanguage)) {
    return { allowed: false, reason: `Voice provider không hỗ trợ ${LANGUAGE_LABELS[targetLanguage]}.` };
  }
  return { allowed: true, reason: '' };
}

export type BatchExportPanelViewProps = {
  currentTargetLanguage: TargetLanguage;
  enabledLanguages: TargetLanguage[];
  selectedLanguages: TargetLanguage[];
  output: ExportOutput;
  voiceCapabilities: VoiceCapabilities;
  busy: boolean;
  results: ExportLaunchDto[];
  error: string;
  onOutputChange: (output: ExportOutput) => void;
  onToggleLanguage: (language: TargetLanguage) => void;
  onExportCurrent: () => void;
  onBatchExport: () => void;
  onRetryFailed: (language: TargetLanguage) => void;
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
  onOutputChange,
  onToggleLanguage,
  onExportCurrent,
  onBatchExport,
  onRetryFailed,
}: BatchExportPanelViewProps) {
  const currentDubbed = dubbedAvailability(voiceCapabilities, currentTargetLanguage);
  const currentAllowed = output === 'subtitles' || currentDubbed.allowed;
  const batchBlocked = output === 'dubbed'
    ? selectedLanguages.some((language) => !dubbedAvailability(voiceCapabilities, language).allowed)
    : false;
  const allSucceeded = results.length > 0 && results.every((result) => result.status === 'queued');

  return (
    <section className="batch-export-panel" data-testid="batch-export-panel" aria-label="Batch export">
      <header><span className="eyebrow">EXPORT</span><h3>Multi-language export</h3></header>

      <label className="field-label">
        Output
        <select value={output} onChange={(event) => onOutputChange(event.currentTarget.value as ExportOutput)}>
          <option value="dubbed" disabled={!currentDubbed.allowed}>Dubbed</option>
          <option value="subtitles">Subtitles</option>
        </select>
      </label>
      {!currentDubbed.allowed && <p className="batch-export-panel__reason">{currentDubbed.reason}</p>}

      <div className="batch-export-panel__targets">
        {enabledLanguages.map((language) => (
          <label key={language}>
            <input
              type="checkbox"
              checked={selectedLanguages.includes(language)}
              onChange={() => onToggleLanguage(language)}
            />
            {LANGUAGE_LABELS[language]}
          </label>
        ))}
      </div>

      <div className="batch-export-panel__actions">
        <button
          data-testid="export-current-language"
          type="button"
          className="secondary-button"
          disabled={busy || !currentAllowed}
          onClick={onExportCurrent}
        >
          Export current language
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || selectedLanguages.length === 0 || batchBlocked}
          onClick={onBatchExport}
        >
          Batch export selected languages
        </button>
      </div>

      <div className="batch-export-panel__results">
        {results.map((result) => (
          <article key={`${result.targetLanguage}:${result.exportId}`}>
            <strong>{LANGUAGE_LABELS[result.targetLanguage]}</strong>
            <span>{result.status === 'queued' ? 'Đã xếp hàng' : 'Thất bại'}</span>
            {result.status === 'failed' && (
              <button type="button" className="ghost-button" onClick={() => onRetryFailed(result.targetLanguage)}>
                Thử lại
              </button>
            )}
          </article>
        ))}
      </div>
      {allSucceeded && <p>Tất cả ngôn ngữ đã xuất thành công</p>}
      {error && <p className="translation-settings__error" role="alert">{error}</p>}
    </section>
  );
}

type BatchExportPanelProps = {
  projectId: string;
  currentTargetLanguage?: TargetLanguage;
  enabledLanguages?: TargetLanguage[];
  selectedLanguages?: TargetLanguage[];
  onSelectedLanguagesChange?: (languages: TargetLanguage[]) => void;
};

const DEFAULT_CAPABILITIES: VoiceCapabilities = {
  configured: false,
  languages: 'unknown',
  cloning: false,
  preview: false,
  cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function BatchExportPanel({
  projectId,
  currentTargetLanguage = 'vi',
  enabledLanguages = ['vi'],
  selectedLanguages: controlledSelected,
  onSelectedLanguagesChange,
}: BatchExportPanelProps) {
  const [localSelected, setLocalSelected] = useState<TargetLanguage[]>(enabledLanguages.slice(0, 1));
  const [output, setOutput] = useState<ExportOutput>('subtitles');
  const [capabilities, setCapabilities] = useState<VoiceCapabilities>(DEFAULT_CAPABILITIES);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ExportLaunchDto[]>([]);
  const [error, setError] = useState('');
  const selectedLanguages = controlledSelected ?? localSelected;

  useEffect(() => {
    let active = true;
    fetchVoiceCapabilities().then((next) => {
      if (active) setCapabilities(next);
    }).catch(() => {
      if (active) setCapabilities(DEFAULT_CAPABILITIES);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const valid = selectedLanguages.filter((language) => enabledLanguages.includes(language));
    if (valid.length !== selectedLanguages.length) {
      if (controlledSelected === undefined) setLocalSelected(valid);
      onSelectedLanguagesChange?.(valid);
    }
  }, [controlledSelected, enabledLanguages, onSelectedLanguagesChange, selectedLanguages]);

  const setSelected = (next: TargetLanguage[]) => {
    if (controlledSelected === undefined) setLocalSelected(next);
    onSelectedLanguagesChange?.(next);
  };

  const exportCurrent = async () => {
    setBusy(true); setError('');
    try {
      const result = await startLanguageExport(projectId, currentTargetLanguage, output);
      setResults((current) => [result, ...current.filter((item) => item.targetLanguage !== currentTargetLanguage)]);
    } catch (launchError) {
      setError(errorMessage(launchError, 'Không thể bắt đầu export.'));
    } finally { setBusy(false); }
  };

  const exportBatch = async () => {
    setBusy(true); setError('');
    try {
      const result = await startBatchExport(projectId, selectedLanguages, output);
      setResults(result.exports);
    } catch (launchError) {
      setError(errorMessage(launchError, 'Không thể bắt đầu batch export.'));
    } finally { setBusy(false); }
  };

  const retryFailed = async (language: TargetLanguage) => {
    setBusy(true); setError('');
    try {
      const replacement = await startLanguageExport(projectId, language, output);
      setResults((current) => current.map((item) => item.targetLanguage === language ? replacement : item));
    } catch (launchError) {
      setError(errorMessage(launchError, `Không thể thử lại ${LANGUAGE_LABELS[language]}.`));
    } finally { setBusy(false); }
  };

  return (
    <BatchExportPanelView
      currentTargetLanguage={currentTargetLanguage}
      enabledLanguages={enabledLanguages}
      selectedLanguages={selectedLanguages}
      output={output}
      voiceCapabilities={capabilities}
      busy={busy}
      results={results}
      error={error}
      onOutputChange={setOutput}
      onToggleLanguage={(language) => setSelected(selectedLanguages.includes(language)
        ? selectedLanguages.filter((item) => item !== language)
        : [...selectedLanguages, language])}
      onExportCurrent={() => { void exportCurrent(); }}
      onBatchExport={() => { void exportBatch(); }}
      onRetryFailed={(language) => { void retryFailed(language); }}
    />
  );
}
