import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { ProjectRepository } from '../db/projects';
import { JobRepository } from '../db/jobs';
import { SegmentRepository } from '../db/segments';
import { UsageRepository } from '../db/usage';
import { ContainerMediaProcessor } from '../services/media/container';
import { asrCapabilities, createAsrProvider } from '../services/asr/router';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';
import { runDubbingPipeline, type DubbingWorkflowParams } from './pipeline';

export class DubbingWorkflow extends WorkflowEntrypoint<Env, DubbingWorkflowParams> {
  async run(event: WorkflowEvent<DubbingWorkflowParams>, step: WorkflowStep) {
    const asr = createAsrProvider(this.env.AI, this.env.DEEPGRAM_API_KEY);
    return runDubbingPipeline(
      event.payload,
      {
        projects: new ProjectRepository(this.env.DB),
        jobs: new JobRepository(this.env.DB),
        media: new ContainerMediaProcessor(this.env.FFMPEG_CONTAINER),
        bucket: this.env.MEDIA,
        asr,
        asrProvider: asrCapabilities(this.env.DEEPGRAM_API_KEY).provider,
        segments: new SegmentRepository(this.env.DB),
        translation: new WorkersAITranslationProvider(this.env.AI),
        usage: new UsageRepository(this.env.DB),
      },
      step,
    );
  }
}
