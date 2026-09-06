import type { TargetLanguage } from '../domain/language';

export type LanguageTranslationWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  targetLanguage: TargetLanguage;
  requestId?: string;
};

export type LanguageTranslationPipelineDeps = Record<string, never>;

export interface LanguageTranslationWorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export async function runLanguageTranslationPipeline(
  _params: LanguageTranslationWorkflowParams,
  _deps: LanguageTranslationPipelineDeps,
  _step: LanguageTranslationWorkflowStepLike,
): Promise<{ status: 'needs_review'; targetLanguage: TargetLanguage; segmentCount: number }> {
  throw new Error('Language translation pipeline is completed in Phase 4C Task 6.');
}
