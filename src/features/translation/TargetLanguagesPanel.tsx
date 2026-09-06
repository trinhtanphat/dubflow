import type {
  ProjectLanguageConfigDto,
  ProjectLanguageStatus,
  TargetLanguage,
} from './languageVariantsApi';

export type StudioLanguage = 'source' | TargetLanguage;

export const LANGUAGE_LABELS: Record<TargetLanguage, string> = {
  vi: 'Tiếng Việt',
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
};

export const LANGUAGE_STATUS_LABELS: Record<ProjectLanguageStatus, string> = {
  pending: 'Chờ xử lý',
  translating: 'Đang dịch',
  needs_review: 'Cần duyệt',
  ready: 'Sẵn sàng',
  exporting: 'Đang xuất',
  completed: 'Hoàn tất',
  failed: 'Thất bại',
};

const ALL_TARGETS: TargetLanguage[] = ['vi', 'en', 'zh', 'ja', 'ko'];

export function recoverProjectLanguagesConflict(
  canonical: ProjectLanguageConfigDto,
  _replay?: () => void,
): ProjectLanguageConfigDto {
  return canonical;
}

type Props = {
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
}: Props) {
  const enabled = new Set(config.languages.map((entry) => entry.targetLanguage));

  return (
    <section className="target-languages" data-testid="target-languages-panel" aria-label="Target Languages">
      <div className="target-languages__head">
        <div><strong>Target Languages</strong><small>rev {config.revision}</small></div>
        <button type="button" className="ghost-button" disabled={saving} onClick={onSaveEnabled}>
          {saving ? 'Đang lưu…' : 'Lưu'}
        </button>
      </div>

      <label className="target-languages__current">
        <span>Đang chỉnh sửa</span>
        <select
          aria-label="Ngôn ngữ đang chỉnh sửa"
          value={currentLanguage}
          onChange={(event) => onCurrentLanguageChange(event.currentTarget.value as StudioLanguage)}
        >
          <option value="source">Source</option>
          {config.languages.map((entry) => (
            <option key={entry.targetLanguage} value={entry.targetLanguage}>
              {LANGUAGE_LABELS[entry.targetLanguage]}
            </option>
          ))}
        </select>
      </label>

      <div className="target-languages__grid" aria-label="Ngôn ngữ đích đã bật">
        {ALL_TARGETS.map((language) => {
          const row = config.languages.find((entry) => entry.targetLanguage === language);
          const isEnabled = enabled.has(language);
          return (
            <article key={language} className={`target-languages__row ${isEnabled ? 'is-enabled' : ''}`}>
              <label>
                <input
                  type="checkbox"
                  checked={isEnabled}
                  disabled={saving}
                  onChange={() => onToggleEnabled(language)}
                />
                <span>{LANGUAGE_LABELS[language]}</span>
              </label>
              {row ? (
                <>
                  <small className={`target-languages__status is-${row.status}`}>{LANGUAGE_STATUS_LABELS[row.status]}</small>
                  <label className="target-languages__batch">
                    <input
                      type="checkbox"
                      checked={selectedLanguages.includes(language)}
                      onChange={() => onToggleSelected(language)}
                    />
                    Batch
                  </label>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={processingLanguage !== null}
                    onClick={() => onProcessLanguage(language)}
                  >
                    {processingLanguage === language ? 'Đang chạy…' : 'Dịch'}
                  </button>
                </>
              ) : <small>Chưa bật</small>}
            </article>
          );
        })}
      </div>
      {error && <p className="target-languages__error" role="alert">{error}</p>}
    </section>
  );
}
