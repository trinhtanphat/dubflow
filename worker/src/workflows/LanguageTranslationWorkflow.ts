import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { JobRepository } from '../db/jobs';
import { ProjectLanguageRepository } from '../db/project-languages';
import { ProjectRepository } from '../db/projects';
import { SegmentTranslationRepository } from '../db/segment-translations';
import { SegmentRepository } from '../db/segments';
import { TranslationContextRepository } from '../db/translation-context';
import { UsageRepository } from '../db/usage';
import { createTelemetry } from '../observability/telemetry';
import { ContextualWorkersAITranslationProvider } from '../services/translation/contextual';
import { GoogleCloudTranslationProvider } from '../services/translation/google';
import { TranslationRouter } from '../services/translation/router';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';
import {
  runLanguageTranslationPipeline,
  type LanguageTranslationWorkflowParams,
} from './languageTranslationPipeline';

export class LanguageTranslationWorkflow extends WorkflowEntrypoint<Env, LanguageTranslationWorkflowParams> {
  async run(event: WorkflowEvent<LanguageTranslationWorkflowParams>, step: WorkflowStep) {
    const translationContext = new TranslationContextRepository(this.env.DB);
    const translationRouter = new TranslationRouter(
      new WorkersAITranslationProvider(this.env.AI),
      new GoogleCloudTranslationProvider(this.env.GOOGLE_CLOUD_TRANSLATE_API_KEY ?? ''),
      new ContextualWorkersAITranslationProvider(
        this.env.AI,
        this.env.CONTEXT_TRANSLATION_MODEL ?? '',
      ),
    );

    return runLanguageTranslationPipeline(
      event.payload,
      {
        projects: new ProjectRepository(this.env.DB),
        jobs: new JobRepository(this.env.DB),
        segments: new SegmentRepository(this.env.DB),
        variants: new SegmentTranslationRepository(this.env.DB),
        languages: new ProjectLanguageRepository(this.env.DB),
        translationContext,
        translationRouter,
        usage: new UsageRepository(this.env.DB),
        telemetry: createTelemetry(this.env),
      },
      step,
    );
  }
}
