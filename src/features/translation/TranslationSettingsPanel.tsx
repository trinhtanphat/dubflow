import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  createGlossaryEntry,
  deleteGlossaryEntry,
  loadGlossary,
  loadTranslationSettings,
  updateGlossaryEntry,
  updateTranslationStyle,
  type GlossaryEntryDto,
} from './translationSettingsApi';
import { getProjectLanguages, type TargetLanguage } from './languageVariantsApi';
import { LANGUAGE_LABELS } from './TargetLanguagesPanel';
import {
  TranslationSettingsPanel as BaseTranslationSettingsPanel,
  TranslationSettingsPanelView as BaseTranslationSettingsPanelView,
  filterGlossaryEntries as baseFilterGlossaryEntries,
} from './TranslationSettingsPanelBase';

export {
  STYLE_OPTIONS,
  validateGlossaryDraft,
  recoverTranslationContextConflict,
} from './TranslationSettingsPanelBase';
export type {
  GlossaryDraft,
  TranslationSettingsServices,
} from './TranslationSettingsPanelBase';

export function filterGlossaryEntries(
  entries: GlossaryEntryDto[],
  filter: string,
  targetLanguage?: TargetLanguage,
): GlossaryEntryDto[] {
  const targeted = targetLanguage
    ? entries.filter((entry) => (entry.targetLanguage ?? 'vi') === targetLanguage)
    : entries;
  return baseFilterGlossaryEntries(targeted, filter);
}

type ViewProps = ComponentProps<typeof BaseTranslationSettingsPanelView> & {
  glossaryTargetLanguage?: TargetLanguage;
  glossaryTargets?: TargetLanguage[];
  onGlossaryTargetChange?: (targetLanguage: TargetLanguage) => void;
};

export function TranslationSettingsPanelView({
  glossaryTargetLanguage = 'vi',
  glossaryTargets = ['vi'],
  onGlossaryTargetChange = () => {},
  glossary,
  ...props
}: ViewProps) {
  const visible = filterGlossaryEntries(glossary, '', glossaryTargetLanguage);
  return (
    <div className="translation-settings-target-shell">
      <label className="translation-settings__target-select">
        <span>Ngôn ngữ thuật ngữ</span>
        <select
          aria-label="Ngôn ngữ thuật ngữ"
          value={glossaryTargetLanguage}
          onChange={(event) => onGlossaryTargetChange(event.currentTarget.value as TargetLanguage)}
        >
          {glossaryTargets.map((language) => (
            <option key={language} value={language}>{LANGUAGE_LABELS[language]}</option>
          ))}
        </select>
      </label>
      <BaseTranslationSettingsPanelView {...props} glossary={visible} />
    </div>
  );
}

type Services = ComponentProps<typeof BaseTranslationSettingsPanel>['services'];

type Props = {
  projectId: string;
  services?: Services;
  targetLanguages?: TargetLanguage[];
};

const defaultServices = {
  loadTranslationSettings,
  loadGlossary,
  updateTranslationStyle,
  createGlossaryEntry,
  updateGlossaryEntry,
  deleteGlossaryEntry,
};

export function TranslationSettingsPanel({ projectId, services, targetLanguages }: Props) {
  const [targets, setTargets] = useState<TargetLanguage[]>(targetLanguages?.length ? targetLanguages : ['vi']);
  const [target, setTarget] = useState<TargetLanguage>(targets[0] ?? 'vi');

  useEffect(() => {
    if (targetLanguages?.length) {
      setTargets(targetLanguages);
      if (!targetLanguages.includes(target)) setTarget(targetLanguages[0] ?? 'vi');
      return;
    }
    let active = true;
    getProjectLanguages(projectId).then((config) => {
      if (!active) return;
      const next = config.languages.map((entry) => entry.targetLanguage);
      const safe: TargetLanguage[] = next.length ? next : ['vi'];
      setTargets(safe);
      setTarget((current) => safe.includes(current) ? current : safe[0]!);
    }).catch(() => {
      if (active) setTargets(['vi']);
    });
    return () => { active = false; };
  }, [projectId, targetLanguages]);

  const base = services ?? defaultServices;
  const targetedServices = useMemo(() => ({
    loadTranslationSettings: base.loadTranslationSettings,
    loadGlossary: (id: string) => base.loadGlossary(id, target),
    updateTranslationStyle: base.updateTranslationStyle,
    createGlossaryEntry: (id: string, revision: number, input: Parameters<typeof createGlossaryEntry>[2]) =>
      base.createGlossaryEntry(id, revision, input, target),
    updateGlossaryEntry: (id: string, entryId: string, revision: number, input: Parameters<typeof updateGlossaryEntry>[3]) =>
      base.updateGlossaryEntry(id, entryId, revision, input, target),
    deleteGlossaryEntry: (id: string, entryId: string, revision: number) =>
      base.deleteGlossaryEntry(id, entryId, revision, target),
  }), [base, target]);

  return (
    <div className="translation-settings-target-shell" data-glossary-target={target}>
      <label className="translation-settings__target-select">
        <span>Ngôn ngữ thuật ngữ</span>
        <select
          aria-label="Ngôn ngữ thuật ngữ"
          value={target}
          onChange={(event) => setTarget(event.currentTarget.value as TargetLanguage)}
        >
          {targets.map((language) => (
            <option key={language} value={language}>{LANGUAGE_LABELS[language]}</option>
          ))}
        </select>
      </label>
      <BaseTranslationSettingsPanel key={`${projectId}:${target}`} projectId={projectId} services={targetedServices} />
    </div>
  );
}
