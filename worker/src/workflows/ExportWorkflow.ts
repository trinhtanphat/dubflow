import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { ProjectRepository } from '../db/projects';
import { JobRepository } from '../db/jobs';
import { SegmentRepository } from '../db/segments';
import { SpeakerRepository } from '../db/speakers';
import { UsageRepository } from '../db/usage';
import { createTelemetry } from '../observability/telemetry';
import { ContainerMediaProcessor } from '../services/media/container';
import { ElevenLabsVoiceProvider } from '../services/voice/elevenlabs';
import { runExportPipeline, type ExportWorkflowParams } from './exportPipeline';

export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportWorkflowParams> {
  async run(event: WorkflowEvent<ExportWorkflowParams>, step: WorkflowStep) {
    const media = new ContainerMediaProcessor(this.env.FFMPEG_CONTAINER);
    return runExportPipeline(
      event.payload,
      {
        projects: new ProjectRepository(this.env.DB),
        jobs: new JobRepository(this.env.DB),
        segments: new SegmentRepository(this.env.DB),
        speakers: new SpeakerRepository(this.env.DB),
        bucket: this.env.MEDIA,
        voice: new ElevenLabsVoiceProvider(
          this.env.ELEVENLABS_API_KEY ?? '',
          { defaultVoiceId: this.env.ELEVENLABS_DEFAULT_VOICE_ID },
        ),
        media,
        usage: new UsageRepository(this.env.DB),
        telemetry: createTelemetry(this.env),
      },
      step,
    );
  }
}
