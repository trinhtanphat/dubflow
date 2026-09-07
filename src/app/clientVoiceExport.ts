import type { ExportOutput } from '../features/export/batchExportApi';
import type { TargetLanguage } from '../features/translation/languageVariantsApi';

export async function launchWithVietnameseClientVoice<T>(
  output: ExportOutput,
  targetLanguages: TargetLanguage[],
  deps: {
    prepareVietnamese: () => Promise<unknown>;
    launch: () => Promise<T>;
  },
): Promise<T> {
  if (output === 'dubbed' && targetLanguages.includes('vi')) {
    await deps.prepareVietnamese();
  }
  return deps.launch();
}
