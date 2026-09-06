import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { BatchExportPanelView } from '../features/export/BatchExportPanel';
import {
  startBatchExport,
  startLanguageExport,
  type ExportLaunchDto,
  type ExportOutput,
} from '../features/export/batchExportApi';
import {
  getProjectLanguages,
  getTranslationVariants,
  patchProjectLanguages,
  patchTranslationVariant,
  processTargetLanguage,
  ProjectLanguagesConflictError,
  TranslationVariantConflictError,
  type ProjectLanguageConfigDto,
  type TargetLanguage,
  type TranslationSegmentDto,
} from '../features/translation/languageVariantsApi';
import {
  TargetLanguagesPanelView,
  recoverProjectLanguagesConflict,
  type StudioLanguage,
} from '../features/translation/TargetLanguagesPanel';
import { fetchVoiceCapabilities, type VoiceCapabilities } from '../features/voice/voiceApi';
import {
  Phase4CStudioProvider,
  composeTargetSegment,
  type Phase4CStudioContextValue,
} from './phase4cStudioContext';
import { StudioShell as BaseStudioShell } from './StudioShellBase';

export {
  createStudioEditorActions,
  deriveStudioSaveState,
  isStudioMutationLocked,
} from './StudioShellBase';
export { composeTargetSegment } from './phase4cStudioContext';

type Props = ComponentProps<typeof BaseStudioShell>;

const FALLBACK_CONFIG: ProjectLanguageConfigDto = {
  revision: 1,
  languages: [{ targetLanguage: 'vi', status: 'pending' }],
};

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function mergeEnabledDraft(config: ProjectLanguageConfigDto, enabled: TargetLanguage[]): ProjectLanguageConfigDto {
  const current = new Map(config.languages.map((entry) => [entry.targetLanguage, entry.status] as const));
  return {
    ...config,
    languages: enabled.map((targetLanguage) => ({
      targetLanguage,
      status: current.get(targetLanguage) ?? 'pending',
    })),
  };
}

function replaceVariant(
  rows: TranslationSegmentDto[],
  segmentId: string,
  translation: TranslationSegmentDto['translation'],
): TranslationSegmentDto[] {
  return rows.map((row) => row.segmentId === segmentId ? { ...row, translation } : row);
}

export function StudioShell(props: Props) {
  const projectId = props.state.project.id;
  const isCloudProject = projectId !== 'demo';
  const [config, setConfig] = useState<ProjectLanguageConfigDto>(FALLBACK_CONFIG);
  const [enabledDraft, setEnabledDraft] = useState<TargetLanguage[]>(['vi']);
  const [currentLanguage, setCurrentLanguage] = useState<StudioLanguage>('vi');
  const [selectedLanguages, setSelectedLanguages] = useState<TargetLanguage[]>(['vi']);
  const [targetSegments, setTargetSegments] = useState<TranslationSegmentDto[]>([]);
  const [targetDrafts, setTargetDrafts] = useState<Record<string, string>>({});
  const [targetConflict, setTargetConflict] = useState('');
  const [languageError, setLanguageError] = useState('');
  const [savingLanguages, setSavingLanguages] = useState(false);
  const [processingLanguage, setProcessingLanguage] = useState<TargetLanguage | null>(null);
  const [voiceCapabilities, setVoiceCapabilities] = useState<VoiceCapabilities | null>(null);
  const [exportOutput, setExportOutput] = useState<ExportOutput>('dubbed');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportResults, setExportResults] = useState<ExportLaunchDto[]>([]);
  const [exportError, setExportError] = useState('');

  useEffect(() => {
    if (!isCloudProject) return;
    let active = true;
    getProjectLanguages(projectId).then((next) => {
      if (!active) return;
      const targets = next.languages.map((entry) => entry.targetLanguage);
      setConfig(next);
      setEnabledDraft(targets);
      setSelectedLanguages((current) => {
        const retained = current.filter((language) => targets.includes(language));
        return retained.length ? retained : targets.slice(0, 1);
      });
      setCurrentLanguage((current) => current === 'source' || targets.includes(current) ? current : (targets[0] ?? 'source'));
    }).catch((error) => {
      if (active) setLanguageError(message(error, 'Không thể tải cấu hình ngôn ngữ.'));
    });
    return () => { active = false; };
  }, [isCloudProject, projectId]);

  useEffect(() => {
    if (!isCloudProject || currentLanguage === 'source') {
      setTargetSegments([]);
      return;
    }
    let active = true;
    getTranslationVariants(projectId, currentLanguage).then((result) => {
      if (active) setTargetSegments(result.segments);
    }).catch((error) => {
      if (active) setLanguageError(message(error, 'Không thể tải bản dịch ngôn ngữ đã chọn.'));
    });
    return () => { active = false; };
  }, [currentLanguage, isCloudProject, projectId]);

  useEffect(() => {
    if (!isCloudProject) return;
    let active = true;
    fetchVoiceCapabilities().then((caps) => {
      if (active) setVoiceCapabilities(caps);
    }).catch(() => {
      if (active) setVoiceCapabilities(null);
    });
    return () => { active = false; };
  }, [isCloudProject]);

  const targetLanguage = currentLanguage === 'source' ? null : currentLanguage;
  const currentDrafts = useMemo(() => {
    if (!targetLanguage) return {};
    const prefix = `${targetLanguage}:`;
    return Object.fromEntries(
      Object.entries(targetDrafts)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
  }, [targetDrafts, targetLanguage]);

  const editTargetTranslation = (segmentId: string, text: string) => {
    if (!targetLanguage) return;
    setTargetConflict('');
    setTargetDrafts((current) => ({ ...current, [`${targetLanguage}:${segmentId}`]: text }));
  };

  const flushTargetTranslation = async (segmentId: string) => {
    if (!targetLanguage) return;
    const row = targetSegments.find((candidate) => candidate.segmentId === segmentId);
    const text = targetDrafts[`${targetLanguage}:${segmentId}`];
    if (text === undefined) return;
    if (!row?.translation) {
      setTargetConflict('Chưa có bản dịch canonical cho ngôn ngữ này. Hãy chạy dịch trước khi chỉnh sửa.');
      return;
    }
    try {
      const result = await patchTranslationVariant(projectId, targetLanguage, segmentId, row.translation.version, text);
      setTargetSegments((current) => replaceVariant(current, segmentId, result.translation));
      setTargetDrafts((current) => {
        const next = { ...current };
        delete next[`${targetLanguage}:${segmentId}`];
        return next;
      });
      setTargetConflict('');
    } catch (error) {
      if (error instanceof TranslationVariantConflictError) {
        setTargetSegments((current) => replaceVariant(current, segmentId, error.canonical));
        setTargetDrafts((current) => {
          const next = { ...current };
          delete next[`${targetLanguage}:${segmentId}`];
          return next;
        });
        setTargetConflict('Bản dịch ngôn ngữ này đã thay đổi ở nơi khác. Đã tải canonical mới nhất.');
        return;
      }
      setTargetConflict(message(error, 'Không thể lưu bản dịch ngôn ngữ đã chọn.'));
    }
  };

  const contextValue: Phase4CStudioContextValue = {
    currentLanguage,
    targetLanguage,
    targetSegments,
    targetDrafts: currentDrafts,
    targetConflict,
    editTargetTranslation,
    flushTargetTranslation,
  };

  const toggleEnabled = (language: TargetLanguage) => {
    setEnabledDraft((current) => current.includes(language)
      ? current.filter((item) => item !== language)
      : [...current, language]);
  };

  const saveEnabled = async () => {
    if (enabledDraft.length === 0 || savingLanguages) return;
    setSavingLanguages(true);
    setLanguageError('');
    try {
      const next = await patchProjectLanguages(projectId, enabledDraft, config.revision);
      setConfig(next);
      const targets = next.languages.map((entry) => entry.targetLanguage);
      setEnabledDraft(targets);
      setSelectedLanguages((current) => current.filter((language) => targets.includes(language)));
      if (currentLanguage !== 'source' && !targets.includes(currentLanguage)) setCurrentLanguage(targets[0] ?? 'source');
    } catch (error) {
      if (error instanceof ProjectLanguagesConflictError) {
        const canonical = recoverProjectLanguagesConflict(error.canonical);
        setConfig(canonical);
        const targets = canonical.languages.map((entry) => entry.targetLanguage);
        setEnabledDraft(targets);
        setLanguageError('Cấu hình ngôn ngữ đã thay đổi ở nơi khác. Đã tải canonical mới nhất.');
      } else {
        setLanguageError(message(error, 'Không thể lưu cấu hình ngôn ngữ.'));
      }
    } finally {
      setSavingLanguages(false);
    }
  };

  const runLanguage = async (language: TargetLanguage) => {
    if (processingLanguage) return;
    setProcessingLanguage(language);
    setLanguageError('');
    try {
      await processTargetLanguage(projectId, language);
      setConfig((current) => ({
        ...current,
        languages: current.languages.map((entry) => entry.targetLanguage === language
          ? { ...entry, status: 'translating' }
          : entry),
      }));
    } catch (error) {
      setLanguageError(message(error, 'Không thể bắt đầu dịch ngôn ngữ đã chọn.'));
    } finally {
      setProcessingLanguage(null);
    }
  };

  const toggleSelected = (language: TargetLanguage) => {
    setSelectedLanguages((current) => current.includes(language)
      ? current.filter((item) => item !== language)
      : [...current, language]);
  };

  const exportTarget = targetLanguage ?? config.languages[0]?.targetLanguage ?? 'vi';

  const exportCurrent = async () => {
    setExportBusy(true);
    setExportError('');
    try {
      const result = await startLanguageExport(projectId, exportTarget, exportOutput);
      setExportResults((current) => [...current.filter((item) => item.targetLanguage !== result.targetLanguage), result]);
    } catch (error) {
      setExportError(message(error, 'Không thể bắt đầu export ngôn ngữ hiện tại.'));
    } finally {
      setExportBusy(false);
    }
  };

  const exportBatch = async () => {
    setExportBusy(true);
    setExportError('');
    try {
      const result = await startBatchExport(projectId, selectedLanguages, exportOutput);
      setExportResults(result.exports);
    } catch (error) {
      setExportError(message(error, 'Không thể bắt đầu batch export.'));
    } finally {
      setExportBusy(false);
    }
  };

  const retryFailed = async (language: TargetLanguage) => {
    setExportBusy(true);
    setExportError('');
    try {
      const result = await startLanguageExport(projectId, language, exportOutput);
      setExportResults((current) => current.map((item) => item.targetLanguage === language ? result : item));
    } catch (error) {
      setExportError(message(error, 'Không thể thử lại export.'));
    } finally {
      setExportBusy(false);
    }
  };

  const displayConfig = mergeEnabledDraft(config, enabledDraft);

  return (
    <Phase4CStudioProvider value={contextValue}>
      <div className="phase4c-studio-wrapper">
        <BaseStudioShell {...props} />
        {isCloudProject && (
          <details className="phase4c-studio-dock">
            <summary>Ngôn ngữ & export</summary>
            <div className="phase4c-studio-dock__body">
              <TargetLanguagesPanelView
                config={displayConfig}
                currentLanguage={currentLanguage}
                selectedLanguages={selectedLanguages}
                saving={savingLanguages}
                processingLanguage={processingLanguage}
                error={languageError}
                onCurrentLanguageChange={(language) => { setCurrentLanguage(language); setTargetConflict(''); }}
                onToggleEnabled={toggleEnabled}
                onSaveEnabled={saveEnabled}
                onToggleSelected={toggleSelected}
                onProcessLanguage={runLanguage}
              />
              <BatchExportPanelView
                currentTargetLanguage={exportTarget}
                enabledLanguages={config.languages.map((entry) => entry.targetLanguage)}
                selectedLanguages={selectedLanguages}
                output={exportOutput}
                voiceCapabilities={voiceCapabilities}
                busy={exportBusy}
                results={exportResults}
                error={exportError}
                onOutputChange={setExportOutput}
                onToggleLanguage={toggleSelected}
                onExportCurrent={exportCurrent}
                onBatchExport={exportBatch}
                onRetryFailed={retryFailed}
              />
            </div>
          </details>
        )}
      </div>
    </Phase4CStudioProvider>
  );
}
