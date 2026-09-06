import { isTargetLanguage, type TargetLanguage } from '../domain/language';

export type LanguageTranslationWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  targetLanguage: TargetLanguage;
  requestId?: string;
};

export async function runLanguageTranslationPipeline(
  params: LanguageTranslationWorkflowParams,
): Promise<never> {
  if (!isTargetLanguage(params.targetLanguage)) {
    throw new Error('Target language is unsupported.');
  }
  throw new Error('Language translation pipeline is not qualified until Phase 4C Task 6.');
}
