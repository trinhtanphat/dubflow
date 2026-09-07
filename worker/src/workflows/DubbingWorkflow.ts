import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { ProjectRepository } from '../db/projects';
import { JobRepository } from '../db/jobs';
import { SegmentRepository } from '../db/segments';
import { TranslationContextRepository } from '../db/translation-context';
import { UsageRepository } from '../db/usage';
import { createTelemetry } from '../observability/telemetry';
import { StreamMediaService } from '../services/media/stream';
import { asrCapabilities, createAsrProvider } from '../services/asr/router';
import { ContextualWorkersAITranslationProvider } from '../services/translation/contextual';
import { GoogleCloudTranslationProvider } from '../services/translation/google';
import { TranslationRouter } from '../services/translation/router';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';
import { runDubbingPipeline, type DubbingWorkflowParams } from './pipeline';

export class DubbingWorkflow extends WorkflowEntrypoint<Env, DubbingWorkflowParams> {
  async run(event: WorkflowEvent<DubbingWorkflowParams>, step: WorkflowStep) {
    const projects = new ProjectRepository(this.env.DB);
    const contextStore = new TranslationContextRepository(this.env.DB);
    const translationRouter = new TranslationRouter(
      new WorkersAITranslationProvider(this.env.AI),
      new GoogleCloudTranslationProvider(this.env.GOOGLE_CLOUD_TRANSLATE_API_KEY ?? ''),
      new ContextualWorkersAITranslationProvider(
        this.env.AI,
        this.env.CONTEXT_TRANSLATION_MODEL ?? '',
      ),
    );
    const sourceMedia = {
      prepareSource: async (projectId: string, userId: string, sourceObjectKey: string) => {
        if (!this.env.STREAM) {
          throw new Error('STREAM_BINDING_UNAVAILABLE: Cloudflare Stream binding is unavailable.');
        }
        return new StreamMediaService({
          projects,
          stream: this.env.STREAM,
          publicOrigin: this.env.PUBLIC_ORIGIN ?? '',
          signingSecret: this.env.STREAM_SOURCE_SIGNING_SECRET ?? '',
        }).prepareSource(projectId, userId, sourceObjectKey);
      },
    };

    return runDubbingPipeline(
      event.payload,
      {
        projects,
        jobs: new JobRepository(this.env.DB),
        sourceMedia,
        asr: createAsrProvider(this.env.AI, this.env.DEEPGRAM_API_KEY),
        asrProviderId: asrCapabilities(this.env.DEEPGRAM_API_KEY).provider,
        segments: new SegmentRepository(this.env.DB),
        translationContext: contextStore,
        translationRouter,
        usage: new UsageRepository(this.env.DB),
        telemetry: createTelemetry(this.env),
      },
      step,
    );
  }
}
