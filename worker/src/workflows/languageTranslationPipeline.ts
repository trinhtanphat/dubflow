import type { Project } from '../db/projects';
import type { DubbingJob, JobStore } from '../db/jobs';
import type { SegmentStore } from '../db/segments';
import type { SegmentTranslationRepository } from '../db/segment-translations';
import type { ProjectLanguageStore } from '../db/project-languages';
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

export interface LanguageTranslationWorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

type PipelineProject = Pick<Project, 'id' | 'sourceLanguage'>;
type PipelineProjects = {
  getByIdForUser(projectId: string, userId: string): Promise<PipelineProject | null>;
};
type PipelineJobs = {
  getForProject(
    projectId: string,
    jobId: string,
    userId: string,
  ): Promise<Pick<DubbingJob, 'status' | 'retryCount'> | null>;
} & Pick<JobStore, 'setProgress' | 'fail' | 'complete'>;
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

function operationKey(
  jobId: string,
  retryCount: number,
  target: TargetLanguage,
  offset: number,
  provider: string,
): string {
  return `job:${jobId}:retry:${retryCount}:translation:${target}:batch-${offset}:${provider}`;
}

function sourceCharacters(texts: string[]): number {
  return Array.from(texts.join('')).length;
}

function providerForContext(active: boolean): 'workers-ai-contextual' | 'workers-ai' {
  return active ? 'workers-ai-contextual' : 'workers-ai';
}

function providerForResult(mode: string): 'workers-ai-contextual' | 'workers-ai' | 'google' {
  if (mode === 'contextual') return 'workers-ai-contextual';
  if (mode === 'google') return 'google';
  return 'workers-ai';
}

function engineForResult(mode: string): 'workers-ai' | 'google' {
  return mode === 'google' ? 'google' : 'workers-ai';
}

export async function runLanguageTranslationPipeline(
  params: LanguageTranslationWorkflowParams,
  deps: LanguageTranslationPipelineDeps,
  step: LanguageTranslationWorkflowStepLike,
): Promise<{ status: 'needs_review'; targetLanguage: TargetLanguage; segmentCount: number }> {
  const target = params.targetLanguage;
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
    if (!Number.isInteger(retryCount) || retryCount < 0) {
      throw new Error('Job retry generation is invalid.');
    }

    await step.do('mark target translating', async () => {
      await deps.languages.setStatus(params.projectId, params.userId, target, 'translating');
      await deps.jobs.setProgress(params.jobId, 0.05, `translating:${target}`);
    });

    const segments = await step.do('load canonical source segments', async () =>
      deps.segments.list(params.projectId, params.userId),
    );
    const context = await step.do('load target translation context snapshot', async () =>
      deps.translationContext.getContext(params.projectId, params.userId, target),
    );
    if (!context) throw new Error('Project translation context not found.');

    const expectedProvider = providerForContext(isTranslationContextActive(context));
    const batchSize = 25;
    for (let offset = 0; offset < segments.length; offset += batchSize) {
      const batch = segments.slice(offset, offset + batchSize);
      const routed = await step.do(`translate ${target} segments ${offset + 1}-${offset + batch.length}`, async () => {
        const items = batch.map((segment) => ({ id: segment.id, text: segment.sourceText }));
        const units = sourceCharacters(items.map((item) => item.text));
        const key = operationKey(params.jobId, retryCount, target, offset, expectedProvider);
        const usage = {
          userId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          kind: 'translation_character' as const,
          units,
          provider: expectedProvider,
          operationKey: key,
        };

        await deps.usage.record({ ...usage, phase: 'started' });
        const result = await withProviderTelemetry(deps.telemetry, {
          requestId: params.requestId,
          actorId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          operation: `translate:${target}`,
          provider: expectedProvider,
          errorCode: 'TRANSLATION_FAILED',
        }, () => deps.translationRouter.translate(
          undefined,
          items,
          project.sourceLanguage,
          target,
          context,
        ));

        if (result.mode === 'compare') {
          throw new Error('Compare mode cannot be persisted by the language translation workflow.');
        }
        const actualProvider = providerForResult(result.mode);
        if (actualProvider !== expectedProvider) {
          throw new Error(`Translation provider mismatch: expected ${expectedProvider}, received ${actualProvider}.`);
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
          if (translated.provider !== actualProvider) {
            throw new Error(`Translation provider mismatch: expected ${actualProvider}, received ${translated.provider}.`);
          }
          seenIds.add(translated.id);
        }
        if (seenIds.size !== expectedIds.size) {
          throw new Error('Translation results are missing one or more segment ids.');
        }

        await deps.usage.record({ ...usage, phase: 'completed' });
        return result;
      });

      const byId = new Map(routed.primary.map((item) => [item.id, item]));
      await step.do(`persist ${target} translations ${offset + 1}-${offset + batch.length}`, async () => {
        for (const segment of batch) {
          const translated = byId.get(segment.id);
          if (!translated) throw new Error(`Missing translation result for ${segment.id}.`);
          await deps.variants.setTranslationResult(
            params.projectId,
            segment.id,
            params.userId,
            target,
            translated.text,
            engineForResult(routed.mode),
            routed.contextRevision,
          );
        }
      });

      const progress = 0.1 + ((offset + batch.length) / Math.max(1, segments.length)) * 0.85;
      await step.do(`persist ${target} translation progress ${offset + 1}`, async () =>
        deps.jobs.setProgress(params.jobId, Math.min(0.95, progress), `translating:${target}`),
      );
    }

    await step.do('mark target review ready', async () => {
      await deps.languages.setStatus(params.projectId, params.userId, target, 'needs_review');
      await deps.jobs.complete(params.jobId, 'needs_review');
    });
    return { status: 'needs_review', targetLanguage: target, segmentCount: segments.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown language translation failure.';
    try {
      await deps.jobs.fail(params.jobId, 'TRANSLATION_FAILED', message);
    } catch {
      // Preserve the original translation failure.
    }
    try {
      await deps.languages.setStatus(params.projectId, params.userId, target, 'failed');
    } catch {
      // Target-status persistence is best-effort; never touch another target here.
    }
    throw error;
  }
}
