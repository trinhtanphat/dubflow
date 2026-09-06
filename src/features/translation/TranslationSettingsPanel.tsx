import { useEffect, useMemo, useState } from 'react';
import {
  TranslationContextConflictError,
  createGlossaryEntry,
  deleteGlossaryEntry,
  loadGlossary,
  loadTranslationSettings,
  updateGlossaryEntry,
  updateTranslationStyle,
  type GlossaryEntryDto,
  type GlossaryEntryInputDto,
  type TranslationContextSnapshotDto,
  type TranslationSettings,
  type TranslationStyle,
} from './translationSettingsApi';
import { LANGUAGE_LABELS } from './TargetLanguagesPanel';
import type { TargetLanguage } from './languageVariantsApi';
import './translation-settings.css';

export const STYLE_OPTIONS: ReadonlyArray<{ value: TranslationStyle; label: string; description: string }> = [
  { value: 'neutral', label: 'Trung tính', description: 'Giữ giọng điệu cân bằng và sát nghĩa.' },
  { value: 'natural', label: 'Tự nhiên', description: 'Ưu tiên câu thoại Việt tự nhiên, dễ nghe.' },
  { value: 'formal', label: 'Trang trọng', description: 'Từ ngữ chuẩn mực và lịch sự hơn.' },
  { value: 'casual', label: 'Thân mật', description: 'Cách nói đời thường, gần gũi.' },
  { value: 'cinematic', label: 'Điện ảnh', description: 'Nhịp câu giàu cảm xúc cho thoại phim.' },
];

export type TranslationSettingsServices = {
  loadTranslationSettings: typeof loadTranslationSettings;
  loadGlossary: typeof loadGlossary;
  updateTranslationStyle: typeof updateTranslationStyle;
  createGlossaryEntry: typeof createGlossaryEntry;
  updateGlossaryEntry: typeof updateGlossaryEntry;
  deleteGlossaryEntry: typeof deleteGlossaryEntry;
};

const defaultServices: TranslationSettingsServices = {
  loadTranslationSettings,
  loadGlossary,
  updateTranslationStyle,
  createGlossaryEntry,
  updateGlossaryEntry,
  deleteGlossaryEntry,
};

export type GlossaryDraft = GlossaryEntryInputDto;

const EMPTY_DRAFT: GlossaryDraft = { sourceTerm: '', preferredTranslation: '', note: null, caseSensitive: false };

function unicodeLength(value: string): number { return Array.from(value).length; }
function searchable(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('vi').trim();
}

export function filterGlossaryEntries(
  entries: GlossaryEntryDto[],
  filter: string,
  targetLanguage?: TargetLanguage,
): GlossaryEntryDto[] {
  const targetEntries = targetLanguage
    ? entries.filter((entry) => (entry.targetLanguage ?? 'vi') === targetLanguage)
    : entries;
  const query = searchable(filter);
  if (!query) return targetEntries;
  return targetEntries.filter((entry) => searchable([
    entry.sourceTerm, entry.preferredTranslation, entry.note ?? '',
  ].join(' ')).includes(query));
}

export function validateGlossaryDraft(draft: GlossaryDraft): string | null {
  const sourceTerm = draft.sourceTerm.trim();
  const preferredTranslation = draft.preferredTranslation.trim();
  const note = draft.note?.trim() ?? '';
  if (!sourceTerm) return 'Thuật ngữ nguồn không được để trống.';
  if (unicodeLength(sourceTerm) > 120) return 'Thuật ngữ nguồn tối đa 120 ký tự.';
  if (!preferredTranslation) return 'Bản dịch ưu tiên không được để trống.';
  if (unicodeLength(preferredTranslation) > 200) return 'Bản dịch ưu tiên tối đa 200 ký tự.';
  if (unicodeLength(note) > 300) return 'Ghi chú tối đa 300 ký tự.';
  return null;
}

export function recoverTranslationContextConflict(canonical: TranslationContextSnapshotDto, _replay?: () => void) {
  return {
    settings: { stylePreset: canonical.style, contextRevision: canonical.revision },
    glossary: canonical.glossary,
    conflictMessage: 'Thiết lập dịch đã thay đổi ở nơi khác. Đã tải bản mới nhất.',
  };
}

type TranslationSettingsPanelViewProps = {
  settings: TranslationSettings;
  glossary: GlossaryEntryDto[];
  glossaryTargetLanguage?: TargetLanguage;
  glossaryTargets?: TargetLanguage[];
  filter: string;
  draft: GlossaryDraft | null;
  editingEntryId: string | null;
  loading: boolean;
  saving: boolean;
  error: string;
  changed: boolean;
  conflictMessage: string;
  onGlossaryTargetChange?: (language: TargetLanguage) => void;
  onFilterChange: (value: string) => void;
  onStyleChange: (style: TranslationStyle) => void;
  onStartCreate: () => void;
  onStartEdit: (entry: GlossaryEntryDto) => void;
  onDraftChange: (patch: Partial<GlossaryDraft>) => void;
  onCancelEdit: () => void;
  onSaveDraft: () => void;
  onDeleteEntry: (entry: GlossaryEntryDto) => void;
};

export function TranslationSettingsPanelView({
  settings, glossary, glossaryTargetLanguage = 'vi', glossaryTargets = ['vi'], filter, draft, editingEntryId,
  loading, saving, error, changed, conflictMessage, onGlossaryTargetChange = () => {}, onFilterChange,
  onStyleChange, onStartCreate, onStartEdit, onDraftChange, onCancelEdit, onSaveDraft, onDeleteEntry,
}: TranslationSettingsPanelViewProps) {
  const visibleEntries = useMemo(
    () => filterGlossaryEntries(glossary, filter, glossaryTargetLanguage),
    [glossary, filter, glossaryTargetLanguage],
  );

  return (
    <section className="translation-settings" data-testid="translation-settings-panel" aria-label="Thiết lập dịch">
      <header className="translation-settings__header">
        <div><span className="eyebrow">DỊCH THUẬT</span><h3>Phong cách & thuật ngữ</h3></div>
        <span className={`translation-settings__capability ${settings.contextualAvailable ? 'is-ready' : 'is-guarded'}`}>
          {settings.contextualAvailable ? 'Dịch theo ngữ cảnh sẵn sàng' : 'Dịch theo ngữ cảnh chưa khả dụng'}
        </span>
      </header>

      <fieldset className="translation-settings__styles" disabled={loading || saving}>
        <legend>Phong cách dịch</legend>
        {STYLE_OPTIONS.map((option) => (
          <label key={option.value} className={settings.stylePreset === option.value ? 'is-selected' : ''}>
            <input type="radio" name="translation-style" value={option.value}
              checked={settings.stylePreset === option.value} onChange={() => onStyleChange(option.value)} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>
        ))}
      </fieldset>

      <label className="translation-settings__glossary-target">
        <span>Ngôn ngữ thuật ngữ</span>
        <select aria-label="Ngôn ngữ thuật ngữ" value={glossaryTargetLanguage}
          onChange={(event) => onGlossaryTargetChange(event.currentTarget.value as TargetLanguage)}>
          {glossaryTargets.map((target) => <option key={target} value={target}>{LANGUAGE_LABELS[target]}</option>)}
        </select>
      </label>

      <div className="translation-settings__glossary-head">
        <div><strong>Thuật ngữ dự án</strong><span>{visibleEntries.length} / 200</span></div>
        <button type="button" className="ghost-button" disabled={saving || glossary.length >= 200} onClick={onStartCreate}>+ Thêm</button>
      </div>

      <input className="translation-settings__search" aria-label="Tìm thuật ngữ" type="search" value={filter}
        placeholder="Tìm thuật ngữ…" onChange={(event) => onFilterChange(event.currentTarget.value)} />

      {draft && (
        <div className="translation-settings__draft">
          <label><span>Thuật ngữ nguồn</span><input value={draft.sourceTerm} maxLength={120}
            onChange={(event) => onDraftChange({ sourceTerm: event.currentTarget.value })} /></label>
          <label><span>Bản dịch ưu tiên</span><input value={draft.preferredTranslation} maxLength={200}
            onChange={(event) => onDraftChange({ preferredTranslation: event.currentTarget.value })} /></label>
          <label><span>Ghi chú</span><textarea value={draft.note ?? ''} maxLength={300} rows={2}
            onChange={(event) => onDraftChange({ note: event.currentTarget.value || null })} /></label>
          <label className="translation-settings__case-toggle"><input type="checkbox" checked={draft.caseSensitive}
            onChange={(event) => onDraftChange({ caseSensitive: event.currentTarget.checked })} />Phân biệt hoa thường</label>
          <div className="translation-settings__draft-actions">
            <button type="button" className="ghost-button" disabled={saving} onClick={onCancelEdit}>Hủy</button>
            <button type="button" className="secondary-button" disabled={saving} onClick={onSaveDraft}>
              {saving ? 'Đang lưu…' : editingEntryId ? 'Lưu thuật ngữ' : 'Thêm thuật ngữ'}
            </button>
          </div>
        </div>
      )}

      <div className="translation-settings__list">
        {visibleEntries.map((entry) => (
          <article key={entry.id} className="translation-settings__entry">
            <div><strong>{entry.sourceTerm}</strong><span>→ {entry.preferredTranslation}</span>
              {entry.note && <small>{entry.note}</small>}{entry.caseSensitive && <em>Phân biệt hoa thường</em>}</div>
            <div className="translation-settings__entry-actions">
              <button type="button" className="ghost-button" disabled={saving} onClick={() => onStartEdit(entry)}>Sửa</button>
              <button type="button" className="ghost-button" disabled={saving} onClick={() => onDeleteEntry(entry)}>Xóa</button>
            </div>
          </article>
        ))}
        {!loading && visibleEntries.length === 0 && <p className="translation-settings__empty">Chưa có thuật ngữ phù hợp.</p>}
      </div>

      {loading && <p className="translation-settings__status">Đang tải thiết lập dịch…</p>}
      {saving && <p className="translation-settings__status">Đang lưu thiết lập…</p>}
      {error && <p className="translation-settings__error" role="alert">{error}</p>}
      {conflictMessage && <p className="translation-settings__conflict" role="alert">{conflictMessage}</p>}
      {changed && <p className="translation-settings__changed">Thiết lập dịch đã thay đổi</p>}
      <p className="translation-settings__hint">Thay đổi chỉ áp dụng cho lần dịch lại hoặc xử lý tiếp theo; nội dung hiện tại không tự bị ghi đè.</p>
    </section>
  );
}

type TranslationSettingsPanelProps = {
  projectId: string;
  glossaryTargets?: TargetLanguage[];
  services?: TranslationSettingsServices;
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function TranslationSettingsPanel({ projectId, glossaryTargets = ['vi', 'en', 'zh', 'ja', 'ko'], services = defaultServices }: TranslationSettingsPanelProps) {
  const [settings, setSettings] = useState<TranslationSettings>({ stylePreset: 'neutral', contextRevision: 1, contextualAvailable: false });
  const [glossary, setGlossary] = useState<GlossaryEntryDto[]>([]);
  const [glossaryTargetLanguage, setGlossaryTargetLanguage] = useState<TargetLanguage>('vi');
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<GlossaryDraft | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const [conflictMessage, setConflictMessage] = useState('');

  const loadTargetGlossary = async (targetLanguage: TargetLanguage) => {
    const result = await services.loadGlossary(projectId, targetLanguage);
    setGlossary((current) => [
      ...current.filter((entry) => (entry.targetLanguage ?? 'vi') !== targetLanguage),
      ...result.glossary.map((entry) => ({ ...entry, targetLanguage: entry.targetLanguage ?? targetLanguage })),
    ]);
  };

  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setConflictMessage('');
    Promise.all([services.loadTranslationSettings(projectId), services.loadGlossary(projectId, glossaryTargetLanguage)])
      .then(([nextSettings, glossaryResult]) => {
        if (!active) return;
        setSettings(nextSettings);
        setGlossary(glossaryResult.glossary.map((entry) => ({ ...entry, targetLanguage: entry.targetLanguage ?? glossaryTargetLanguage })));
        setChanged(false);
      }).catch((loadError) => { if (active) setError(errorText(loadError, 'Không thể tải thiết lập dịch.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, services]);

  const recoverConflict = (mutationError: unknown): boolean => {
    if (!(mutationError instanceof TranslationContextConflictError)) return false;
    const recovered = recoverTranslationContextConflict(mutationError.canonical);
    setSettings((current) => ({ ...current, stylePreset: recovered.settings.stylePreset, contextRevision: recovered.settings.contextRevision }));
    setGlossary(recovered.glossary);
    setConflictMessage(recovered.conflictMessage);
    setDraft(null); setEditingEntryId(null);
    return true;
  };

  const changeGlossaryTarget = async (targetLanguage: TargetLanguage) => {
    setGlossaryTargetLanguage(targetLanguage); setFilter(''); setDraft(null); setEditingEntryId(null); setLoading(true); setError('');
    try { await loadTargetGlossary(targetLanguage); }
    catch (loadError) { setError(errorText(loadError, 'Không thể tải thuật ngữ.')); }
    finally { setLoading(false); }
  };

  const changeStyle = async (stylePreset: TranslationStyle) => {
    if (stylePreset === settings.stylePreset || saving) return;
    setSaving(true); setError(''); setConflictMessage('');
    try { const next = await services.updateTranslationStyle(projectId, settings.contextRevision, stylePreset); setSettings(next); setChanged(true); }
    catch (mutationError) { if (!recoverConflict(mutationError)) setError(errorText(mutationError, 'Không thể lưu phong cách dịch.')); }
    finally { setSaving(false); }
  };

  const startCreate = () => {
    if (glossary.length >= 200) { setError('Dự án đã đạt giới hạn 200 thuật ngữ.'); return; }
    setEditingEntryId(null); setDraft({ ...EMPTY_DRAFT }); setError('');
  };
  const startEdit = (entry: GlossaryEntryDto) => {
    setEditingEntryId(entry.id);
    setDraft({ sourceTerm: entry.sourceTerm, preferredTranslation: entry.preferredTranslation, note: entry.note, caseSensitive: entry.caseSensitive });
    setError('');
  };

  const saveDraft = async () => {
    if (!draft || saving) return;
    const validation = validateGlossaryDraft(draft); if (validation) { setError(validation); return; }
    setSaving(true); setError(''); setConflictMessage('');
    try {
      const result = editingEntryId
        ? await services.updateGlossaryEntry(projectId, editingEntryId, settings.contextRevision, draft, glossaryTargetLanguage)
        : await services.createGlossaryEntry(projectId, settings.contextRevision, draft, glossaryTargetLanguage);
      setSettings((current) => ({ ...current, stylePreset: result.context.style, contextRevision: result.contextRevision }));
      setGlossary((current) => [
        ...current.filter((entry) => (entry.targetLanguage ?? 'vi') !== glossaryTargetLanguage),
        ...result.context.glossary.map((entry) => ({ ...entry, targetLanguage: entry.targetLanguage ?? glossaryTargetLanguage })),
      ]);
      setDraft(null); setEditingEntryId(null); setChanged(true);
    } catch (mutationError) { if (!recoverConflict(mutationError)) setError(errorText(mutationError, 'Không thể lưu thuật ngữ.')); }
    finally { setSaving(false); }
  };

  const removeEntry = async (entry: GlossaryEntryDto) => {
    if (saving) return;
    setSaving(true); setError(''); setConflictMessage('');
    try {
      const result = await services.deleteGlossaryEntry(projectId, entry.id, settings.contextRevision, glossaryTargetLanguage);
      setSettings((current) => ({ ...current, stylePreset: result.context.style, contextRevision: result.contextRevision }));
      setGlossary((current) => [
        ...current.filter((item) => (item.targetLanguage ?? 'vi') !== glossaryTargetLanguage),
        ...result.context.glossary.map((item) => ({ ...item, targetLanguage: item.targetLanguage ?? glossaryTargetLanguage })),
      ]);
      setChanged(true);
      if (editingEntryId === entry.id) { setDraft(null); setEditingEntryId(null); }
    } catch (mutationError) { if (!recoverConflict(mutationError)) setError(errorText(mutationError, 'Không thể xóa thuật ngữ.')); }
    finally { setSaving(false); }
  };

  return <TranslationSettingsPanelView
    settings={settings} glossary={glossary} glossaryTargetLanguage={glossaryTargetLanguage} glossaryTargets={glossaryTargets}
    filter={filter} draft={draft} editingEntryId={editingEntryId} loading={loading} saving={saving} error={error}
    changed={changed} conflictMessage={conflictMessage} onGlossaryTargetChange={(language) => { void changeGlossaryTarget(language); }}
    onFilterChange={setFilter} onStyleChange={(style) => { void changeStyle(style); }} onStartCreate={startCreate} onStartEdit={startEdit}
    onDraftChange={(patch) => setDraft((current) => current ? { ...current, ...patch } : current)}
    onCancelEdit={() => { setDraft(null); setEditingEntryId(null); setError(''); }} onSaveDraft={() => { void saveDraft(); }}
    onDeleteEntry={(entry) => { void removeEntry(entry); }} />;
}
