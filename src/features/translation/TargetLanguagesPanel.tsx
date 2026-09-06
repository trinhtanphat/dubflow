import { useEffect, useMemo, useState } from 'react';
import {
  ProjectLanguagesConflictError,
  getProjectLanguages,
  patchProjectLanguages,
  processTargetLanguage,
  type ProjectLanguageConfigDto,
  type ProjectLanguageStatus,
  type TargetLanguage,
} from './languageVariantsApi';

export const LANGUAGE_LABELS = {
  vi: 'Tiếng Việt',
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
} as const satisfies Record<TargetLanguage, string>;

const ALL_TARGETS = Object.keys(LANGUAGE_LABELS) as TargetLanguage[];

const STATUS_LABELS: Record<ProjectLanguageStatus, string> = {
  pending: 'Chờ xử lý',
  translating: 'Đang dịch',
  needs_review: 'Cần duyệt',
  ready: 'Sẵn sàng',
  exporting: 'Đang xuất',
  completed: 'Hoàn tất',
  failed: 'Thất bại',
};

export type StudioLanguage = 'source' | TargetLanguage;

export function recoverProjectLanguagesConflict(
  canonical: ProjectLanguageConfigDto,
  _replay?: () => void,
): ProjectLanguageConfigDto {
  return canonical;
}

export type TargetLanguagesPanelViewProps = {
  config: ProjectLanguageConfigDto;
  currentLanguage: StudioLanguage;
  selectedLanguages: TargetLanguage[];
  saving: boolean;
  processingLanguage: TargetLanguage | null;
  error: string;
  onCurrentLanguageChange: (language: StudioLanguage) => void;
  onToggleEnabled: (language: TargetLanguage) => void;
  onSaveEnabled: () => void;
  onToggleSelected: (language: TargetLanguage) => void;
  onProcessLanguage: (language: TargetLanguage) => void;
};

export function TargetLanguagesPanelView({
  config,
  currentLanguage,
  selectedLanguages,
  saving,
  processingLanguage,
  error,
  onCurrentLanguageChange,
  onToggleEnabled,
  onSaveEnabled,
  onToggleSelected,
  onProcessLanguage,
}: TargetLanguagesPanelViewProps) {
  const enabled = new Set(config.languages.map((entry) => entry.targetLanguage));

  return (
    <section className="target-languages-panel" data-testid="target-languages-panel" aria-label="Ngôn ngữ đích">
      <header className="target-languages-panel__header">
        <div><span className="eyebrow">NGÔN NGỮ ĐÍCH</span><h3>Target Languages</h3></div>
        <span>rev {config.revision}</span>
      </header>

      <label className="field-label">
        Ngôn ngữ đang chỉnh sửa
        <select
          aria-label="Ngôn ngữ đang chỉnh sửa"
          value={currentLanguage}
          onChange={(event) => onCurrentLanguageChange(event.currentTarget.value as StudioLanguage)}
        >
          <option value="source">Source</option>
          {config.languages.map((entry) => (
            <option key={entry.targetLanguage} value={entry.targetLanguage}>{LANGUAGE_LABELS[entry.targetLanguage]}</option>
          ))}
        </select>
      </label>

      <div className="target-languages-panel__targets">
        {ALL_TARGETS.map((language) => {
          const row = config.languages.find((entry) => entry.targetLanguage === language);
          return (
            <article key={language} className={`target-language-row ${row ? 'is-enabled' : ''}`}>
              <label>
                <input
                  type="checkbox"
                  checked={enabled.has(language)}
                  onChange={() => onToggleEnabled(language)}
                />
                <strong>{LANGUAGE_LABELS[language]}</strong>
              </label>
              {row && <span className={`language-status language-status--${row.status}`}>{STATUS_LABELS[row.status]}</span>}
              {row && (
                <label className="target-language-row__batch">
                  <input
                    type="checkbox"
                    checked={selectedLanguages.includes(language)}
                    onChange={() => onToggleSelected(language)}
                  />
                  Batch
                </label>
              )}
              {row && (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={processingLanguage !== null || saving}
                  onClick={() => onProcessLanguage(language)}
                >
                  {processingLanguage === language ? 'Đang dịch…' : 'Dịch'}
                </button>
              )}
            </article>
          );
        })}
      </div>

      <button type="button" className="secondary-button" disabled={saving} onClick={onSaveEnabled}>
        {saving ? 'Đang lưu…' : 'Lưu ngôn ngữ'}
      </button>
      {error && <p className="translation-settings__error" role="alert">{error}</p>}
    </section>
  );
}

type TargetLanguagesPanelProps = {
  projectId: string;
  currentLanguage?: StudioLanguage;
  onCurrentLanguageChange?: (language: StudioLanguage) => void;
  selectedLanguages?: TargetLanguage[];
  onSelectedLanguagesChange?: (languages: TargetLanguage[]) => void;
};

const FALLBACK_CONFIG: ProjectLanguageConfigDto = {
  revision: 1,
  languages: [{ targetLanguage: 'vi', status: 'pending' }],
};

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function TargetLanguagesPanel({
  projectId,
  currentLanguage: controlledCurrent,
  onCurrentLanguageChange,
  selectedLanguages: controlledSelected,
  onSelectedLanguagesChange,
}: TargetLanguagesPanelProps) {
  const [config, setConfig] = useState<ProjectLanguageConfigDto>(FALLBACK_CONFIG);
  const [draftTargets, setDraftTargets] = useState<TargetLanguage[]>(['vi']);
  const [localCurrent, setLocalCurrent] = useState<StudioLanguage>('vi');
  const [localSelected, setLocalSelected] = useState<TargetLanguage[]>(['vi']);
  const [saving, setSaving] = useState(false);
  const [processingLanguage, setProcessingLanguage] = useState<TargetLanguage | null>(null);
  const [error, setError] = useState('');

  const currentLanguage = controlledCurrent ?? localCurrent;
  const selectedLanguages = controlledSelected ?? localSelected;

  useEffect(() => {
    let active = true;
    getProjectLanguages(projectId).then((next) => {
      if (!active) return;
      setConfig(next);
      const enabled = next.languages.map((entry) => entry.targetLanguage);
      setDraftTargets(enabled);
      setLocalSelected((current) => current.filter((language) => enabled.includes(language)).length
        ? current.filter((language) => enabled.includes(language))
        : enabled.slice(0, 1));
      setLocalCurrent((current) => current !== 'source' && enabled.includes(current) ? current : (enabled[0] ?? 'source'));
    }).catch((loadError) => {
      if (active) setError(message(loadError, 'Không thể tải ngôn ngữ dự án.'));
    });
    return () => { active = false; };
  }, [projectId]);

  const viewConfig = useMemo<ProjectLanguageConfigDto>(() => ({
    ...config,
    languages: draftTargets.map((targetLanguage) => config.languages.find((entry) => entry.targetLanguage === targetLanguage)
      ?? { targetLanguage, status: 'pending' as const }),
  }), [config, draftTargets]);

  const setCurrent = (language: StudioLanguage) => {
    setLocalCurrent(language);
    onCurrentLanguageChange?.(language);
  };

  const setSelected = (languages: TargetLanguage[]) => {
    setLocalSelected(languages);
    onSelectedLanguagesChange?.(languages);
  };

  const toggleEnabled = (language: TargetLanguage) => {
    setDraftTargets((current) => current.includes(language)
      ? current.filter((item) => item !== language)
      : [...current, language]);
  };

  const saveEnabled = async () => {
    if (saving || draftTargets.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const next = await patchProjectLanguages(projectId, draftTargets, config.revision);
      setConfig(next);
      const enabled = next.languages.map((entry) => entry.targetLanguage);
      setDraftTargets(enabled);
      setSelected(selectedLanguages.filter((language) => enabled.includes(language)));
      if (currentLanguage !== 'source' && !enabled.includes(currentLanguage)) setCurrent(enabled[0] ?? 'source');
    } catch (saveError) {
      if (saveError instanceof ProjectLanguagesConflictError) {
        const canonical = recoverProjectLanguagesConflict(saveError.canonical);
        setConfig(canonical);
        setDraftTargets(canonical.languages.map((entry) => entry.targetLanguage));
        setError('Cấu hình ngôn ngữ đã thay đổi ở nơi khác. Đã tải bản mới nhất.');
      } else {
        setError(message(saveError, 'Không thể lưu ngôn ngữ dự án.'));
      }
    } finally {
      setSaving(false);
    }
  };

  const processLanguage = async (language: TargetLanguage) => {
    if (processingLanguage) return;
    setProcessingLanguage(language);
    setError('');
    try {
      await processTargetLanguage(projectId, language);
      setConfig((current) => ({
        ...current,
        languages: current.languages.map((entry) => entry.targetLanguage === language
          ? { ...entry, status: 'translating' }
          : entry),
      }));
    } catch (processError) {
      setError(message(processError, 'Không thể bắt đầu dịch ngôn ngữ này.'));
    } finally {
      setProcessingLanguage(null);
    }
  };

  return (
    <TargetLanguagesPanelView
      config={viewConfig}
      currentLanguage={currentLanguage}
      selectedLanguages={selectedLanguages}
      saving={saving}
      processingLanguage={processingLanguage}
      error={error}
      onCurrentLanguageChange={setCurrent}
      onToggleEnabled={toggleEnabled}
      onSaveEnabled={() => { void saveEnabled(); }}
      onToggleSelected={(language) => setSelected(selectedLanguages.includes(language)
        ? selectedLanguages.filter((item) => item !== language)
        : [...selectedLanguages, language])}
      onProcessLanguage={(language) => { void processLanguage(language); }}
    />
  );
}
