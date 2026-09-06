import { useEffect, useState } from 'react';
import {
  TARGET_LANGUAGES,
  fetchExportVariants,
  fetchProjectTargets,
  saveProjectTargets,
  startBatchExport,
  targetExportMediaHref,
  type ExportVariant,
  type TargetLanguage,
} from './multilangExportApi';

const TARGET_LABELS: Record<TargetLanguage, string> = {
  vi: 'VI',
  en: 'EN',
  ja: 'JA',
  ko: 'KO',
  zh: 'ZH',
};

const STATUS_LABELS: Record<ExportVariant['status'], string> = {
  queued: 'Đang chờ',
  running: 'Đang render',
  completed: 'Hoàn tất',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};

function canonicalizeTargets(targets: TargetLanguage[]): TargetLanguage[] {
  const selected = new Set(targets);
  return TARGET_LANGUAGES.filter((target) => selected.has(target));
}

export function toggleTargetSelection(
  current: TargetLanguage[],
  target: TargetLanguage,
): TargetLanguage[] {
  const selected = canonicalizeTargets(current);
  if (selected.includes(target)) {
    if (selected.length === 1) return selected;
    return selected.filter((item) => item !== target);
  }
  if (selected.length >= 4) return selected;
  return canonicalizeTargets([...selected, target]);
}

export function latestExportVariants(variants: ExportVariant[]): ExportVariant[] {
  const seen = new Set<TargetLanguage>();
  return variants.filter((variant) => {
    if (seen.has(variant.targetLanguage)) return false;
    seen.add(variant.targetLanguage);
    return true;
  });
}

export type MultiLanguageExportPanelViewProps = {
  projectId: string;
  selectedTargets: TargetLanguage[];
  variants: ExportVariant[];
  loading: boolean;
  busy: boolean;
  error: string;
  onToggle(target: TargetLanguage): void;
  onSave(): void;
  onStartBatch(): void;
  onRefresh(): void;
  onShareVariant(exportId: string): void;
};

export function MultiLanguageExportPanelView({
  projectId,
  selectedTargets,
  variants,
  loading,
  busy,
  error,
  onToggle,
  onSave,
  onStartBatch,
  onRefresh,
  onShareVariant,
}: MultiLanguageExportPanelViewProps) {
  const latest = latestExportVariants(variants);
  const disabled = loading || busy;

  return (
    <section
      className="multi-language-export-panel"
      data-testid="multi-language-export-panel"
      aria-label="Xuất đa ngôn ngữ"
    >
      <header className="multi-language-export-panel__header">
        <div>
          <span className="eyebrow">PHASE 4C</span>
          <h3>Xuất đa ngôn ngữ</h3>
        </div>
        <button type="button" className="ghost-button" disabled={disabled} onClick={onRefresh}>Làm mới</button>
      </header>

      <p className="multi-language-export-panel__hint">Chọn 1–4 ngôn ngữ</p>
      <div className="multi-language-export-panel__targets" aria-label="Ngôn ngữ xuất">
        {TARGET_LANGUAGES.map((target) => {
          const selected = selectedTargets.includes(target);
          return (
            <button
              key={target}
              type="button"
              className={selected ? 'is-selected' : ''}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onToggle(target)}
            >
              {TARGET_LABELS[target]}
            </button>
          );
        })}
      </div>

      <div className="multi-language-export-panel__actions">
        <button type="button" className="ghost-button" disabled={disabled} onClick={onSave}>Lưu ngôn ngữ</button>
        <button type="button" className="primary-button" disabled={disabled} onClick={onStartBatch}>
          {busy ? 'Đang xử lý…' : 'Xuất batch'}
        </button>
      </div>

      {error ? <p className="multi-language-export-panel__error" role="alert">{error}</p> : null}
      {loading ? <p className="multi-language-export-panel__status">Đang tải trạng thái export…</p> : null}

      {!loading && latest.length === 0 ? (
        <p className="multi-language-export-panel__status">Chưa có bản export đa ngôn ngữ.</p>
      ) : null}

      <div className="multi-language-export-panel__variants" aria-live="polite">
        {latest.map((variant) => (
          <article
            className={`multi-language-export-panel__variant is-${variant.status}`}
            key={variant.id}
          >
            <div>
              <strong>{TARGET_LABELS[variant.targetLanguage]}</strong>
              <span>{STATUS_LABELS[variant.status]}</span>
              {variant.errorCode ? <small>{variant.errorCode}</small> : null}
            </div>
            {variant.status === 'completed' && variant.objectKey ? (
              <div className="multi-language-export-panel__variant-actions">
                <a href={targetExportMediaHref(projectId, variant.id)}>Tải MP4</a>
                <button type="button" disabled={busy} onClick={() => onShareVariant(variant.id)}>Chia sẻ</button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export type MultiLanguageExportPanelProps = {
  projectId: string;
  onShareVariant(exportId: string): void;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function boundedTargets(targets: TargetLanguage[]): TargetLanguage[] {
  const canonical = canonicalizeTargets(targets);
  if (canonical.length === 0) return ['vi'];
  return canonical.slice(0, 4);
}

export function MultiLanguageExportPanel({ projectId, onShareVariant }: MultiLanguageExportPanelProps) {
  const [selectedTargets, setSelectedTargets] = useState<TargetLanguage[]>(['vi']);
  const [variants, setVariants] = useState<ExportVariant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    const exports = await fetchExportVariants(projectId);
    setVariants(exports);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([fetchProjectTargets(projectId), fetchExportVariants(projectId)])
      .then(([targets, exports]) => {
        if (cancelled) return;
        setSelectedTargets(boundedTargets(targets));
        setVariants(exports);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason, 'Không thể tải cấu hình xuất đa ngôn ngữ.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const save = async () => {
    if (busy || loading) return;
    setBusy(true);
    setError('');
    try {
      await saveProjectTargets(projectId, selectedTargets);
    } catch (reason) {
      setError(errorMessage(reason, 'Không thể lưu ngôn ngữ xuất.'));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy || loading) return;
    setBusy(true);
    setError('');
    try {
      await startBatchExport(projectId, selectedTargets);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, 'Không thể bắt đầu batch export.'));
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    if (busy || loading) return;
    setBusy(true);
    setError('');
    try {
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, 'Không thể làm mới trạng thái export.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MultiLanguageExportPanelView
      projectId={projectId}
      selectedTargets={selectedTargets}
      variants={variants}
      loading={loading}
      busy={busy}
      error={error}
      onToggle={(target) => setSelectedTargets((current) => toggleTargetSelection(current, target))}
      onSave={() => { void save(); }}
      onStartBatch={() => { void start(); }}
      onRefresh={() => { void reload(); }}
      onShareVariant={onShareVariant}
    />
  );
}
