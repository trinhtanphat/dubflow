import type { JobStore } from '../db/jobs';
import type { ProjectLanguageStore } from '../db/project-languages';
import type { ProjectStore } from '../db/projects';
import type { SegmentTranslationRepository } from '../db/segment-translations';
import type { SegmentStore } from '../db/segments';
import type { TranslationContextStore } from '../db/translation-context';
import type { UsageStore } from '../db/usage';
import type { TargetLanguage } from '../domain/language';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import { isTranslationContextActive } from '../services/translation/context';
import type { TranslationRouter } from '../services/translation/router';

export type LanguageTranslationWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  targetLanguage: TargetLanguage;
  requestId?: string;
};

type PipelineProjects = Pick<ProjectStore, 'getByIdForUser'>;
type PipelineJobs = Pick<JobStore, 'getForProject' | 'setProgress' | 'fail' | 'complete'>;
type PipelineSegments = Pick<SegmentStore, 'list'>;
type PipelineVariants = Pick<SegmentTranslationRepository, 'setTranslationResult'>;
type PipelineLanguages = Pick<ProjectLanguageStore, 'setStatus'>;
type PipelineContext = Pick<TranslationContextStore, 'getContext'>;
type PipelineRouter = Pick<TranslationRouter, 'translate'>;
type PipelineUsage = Pick<UsageStore, 'record'>;

export type LanguageTranslationPipelineDeps = {
  projects: PipelineProjects;
  jobs: PipelineJobs;
  segments: PipelineSegments;
  variants: PipelineVariants;
  languages: PipelineLanguages;
  translationContext: PipelineContext;
  translationRouter: PipelineRouter;
  usage: PipelineUsage;
  telemetry: TelemetrySink;
};

export interface LanguageTranslationWorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown target translation failure.';
}

function sourceCharacters(items: Array<{ text: string }>): number {
  return Array.from(items.map((item) => item.text).join('')).length;
}

function expectedProvider(context: Awaited<ReturnType<TranslationContextStore['getContext']>>): string {
  return context && isTranslationContextActive(context) ? 'workers-ai-contextual' : 'workers-ai';
}

function operationKey(
  jobId: string,
  retryCount: number,
  target: TargetLanguage,
  offset: number,
  provider: string,
): string {
  return `job:${jobId}:retry:${retryCount}:translation:${target}:batch-${offset}:${provider}`;
}

export async function runLanguageTranslationPipeline(
  params: LanguageTranslationWorkflowParams,
  deps: LanguageTranslationPipelineDeps,
  step: LanguageTranslationWorkflowStepLike,
): Promise<{ status: 'needs_review'; targetLanguage: TargetLanguage; segmentCount: number }> {
  try {
    const project = await step.do('authorize project', async () =>
      deps.projects.getByIdForUser(params.projectId, params.userId),
    );
    if (!project) throw new Error('Project not found.');

    const job = await step.do('load usage retry generation', async () =>
      deps.jobs.getForProject(params.projectId, params.jobId, params.userId),
    );
    if (!job) throw new Error('Job not found.');
    const retryCount = job.retryCount;
    if (!Number.isInteger(retryCount) || retryCount < 0) throw new Error('Job retry generation is invalid.');

    await step.do('mark target translating', async () => {
      await deps.languages.setStatus(params.projectId, params.userId, params.targetLanguage, 'translating');
      await deps.jobs.setProgress(params.jobId, 0.05, `translating:${params.targetLanguage}`);
    });

    const canonicalSegments = await step.do('load canonical source segments', async () =>
      deps.segments.list(params.projectId, params.userId),
    );
    const context = await step.do('load target translation context snapshot', async () =>
      deps.translationContext.getContext(params.projectId, params.userId, params.targetLanguage),
    );
    if (!context) throw new Error('Project translation context not found.');
    const provider = expectedProvider(context);

    const batchSize = 25;
    for (let offset = 0; offset < canonicalSegments.length; offset += batchSize) {
      const batch = canonicalSegments.slice(offset, offset + batchSize);
      const routed = await step.do(
        `translate ${params.targetLanguage} segments ${offset + 1}-${offset + batch.length}`,
        async () => {
          const items = batch.map((segment) => ({ id: segment.id, text: segment.sourceText }));
          const units = sourceCharacters(items);
          const key = operationKey(params.jobId, retryCount, params.targetLanguage, offset, provider);
          const common = {
            userId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            kind: 'translation_character' as const,
            units,
            provider,
            operationKey: key,
          };

          await deps.usage.record({ ...common, phase: 'started' });
          const result = await withProviderTelemetry(deps.telemetry, {
            requestId: params.requestId,
            actorId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            operation: 'translate',
            provider,
            errorCode: 'TRANSLATION_FAILED',
          }, () => deps.translationRouter.translate(
            undefined,
            items,
            project.sourceLanguage,
            params.targetLanguage,
            context,
          ));

          if (result.mode === 'compare') {
            throw new Error('Compare mode cannot be persisted by the target translation workflow.');
          }
          const routedProvider = result.mode === 'contextual'
            ? 'workers-ai-contextual'
            : result.mode === 'google'
              ? 'google'
              : 'workers-ai';
          if (routedProvider !== provider) {
            throw new Error(`Translation provider mismatch: expected ${provider}, received ${routedProvider}.`);
          }
          if (result.primary.length !== items.length) {
            throw new Error(`Translation result count mismatch: expected ${items.length}, received ${result.primary.length}.`);
          }
          const expectedIds = new Set(items.map((item) => item.id));
          const seenIds = new Set<string>();
          for (const translated of result.primary) {
            if (!expectedIds.has(translated.id) || seenIds.has(translated.id)) {
              throw new Error(`Translation result id mismatch: ${translated.id}.`);
            }
            if (translated.provider !== routedProvider) {
              throw new Error(`Translation provider mismatch: expected ${routedProvider}, received ${translated.provider}.`);
            }
            seenIds.add(translated.id);
          }
          if (seenIds.size !== expectedIds.size) {
            throw new Error('Translation results are missing one or more segment ids.');
          }

          await deps.usage.record({ ...common, phase: 'completed' });
          return result;
        },
      );

      const byId = new Map(routed.primary.map((item) => [item.id, item]));
      await step.do(
        `persist ${params.targetLanguage} translations ${offset + 1}-${offset + batch.length}`,
        async () => {
          for (const segment of batch) {
            const translated = byId.get(segment.id);
            if (!translated) throw new Error(`Missing translation result for ${segment.id}.`);
            await deps.variants.setTranslationResult(
              params.projectId,
              segment.id,
              params.userId,
              params.targetLanguage,
              translated.text,
              routed.mode === 'google' ? 'google' : 'workers-ai',
              routed.contextRevision,
            );
          }
        },
      );

      const progress = 0.1 + ((offset + batch.length) / Math.max(1, canonicalSegments.length)) * 0.85;
      await step.do(`persist ${params.targetLanguage} translation progress ${offset + 1}`, async () =>
        deps.jobs.setProgress(params.jobId, progress, `translating:${params.targetLanguage}`),
      );
    }

    await step.do('mark target review ready', async () => {
      await deps.languages.setStatus(params.projectId, params.userId, params.targetLanguage, 'needs_review');
      await deps.jobs.complete(params.jobId, 'needs_review');
    });

    return {
      status: 'needs_review',
      targetLanguage: params.targetLanguage,
      segmentCount: canonicalSegments.length,
    };
  } catch (error) {
    const message = errorMessage(error);
    try {
      await deps.jobs.fail(params.jobId, 'TRANSLATION_FAILED', message);
      await deps.languages.setStatus(params.projectId, params.userId, params.targetLanguage, 'failed');
    } catch {
      // Preserve the original provider/persistence error if failure-state persistence also fails.
    }
    throw error;
  }
}
