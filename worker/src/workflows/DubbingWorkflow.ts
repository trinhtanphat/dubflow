import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { ProjectRepository } from '../db/projects';
import { JobRepository } from '../db/jobs';
import { SegmentRepository } from '../db/segments';
import { ContainerMediaProcessor } from '../services/media/container';
import { WorkersAIAsrProvider } from '../services/asr/workers-ai';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';
import { runDubbingPipeline, type DubbingWorkflowParams } from './pipeline';

export class DubbingWorkflow extends WorkflowEntrypoint<Env, DubbingWorkflowParams> {
  async run(event: WorkflowEvent<DubbingWorkflowParams>, step: WorkflowStep) {
    return runDubbingPipeline(
      event.payload,
      {
        projects: new ProjectRepository(this.env.DB),
        jobs: new JobRepository(this.env.DB),
        media: new ContainerMediaProcessor(this.env.FFMPEG_CONTAINER),
        bucket: this.env.MEDIA,
        asr: new WorkersAIAsrProvider(this.env.AI),
        segments: new SegmentRepository(this.env.DB),
        translation: new WorkersAITranslationProvider(this.env.AI),
      },
      step,
    );
  }
}
