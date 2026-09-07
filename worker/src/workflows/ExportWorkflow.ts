import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { AudioStemRepository } from '../db/audio-stems';
import { ProjectRepository } from '../db/projects';
import { JobRepository } from '../db/jobs';
import { SegmentRepository } from '../db/segments';
import { SegmentTranslationRepository } from '../db/segment-translations';
import { ProjectExportRepository } from '../db/project-exports';
import { ProviderMediaGrantRepository } from '../db/provider-media-grants';
import { SpeakerRepository } from '../db/speakers';
import { UsageRepository } from '../db/usage';
import { createTelemetry } from '../observability/telemetry';
import { createProviderMediaToken } from '../security/provider-media-token';
import { qualifiedSyncLabsApiKey } from '../services/lipsync/qualification';
import { SyncLabsLipSyncProvider } from '../services/lipsync/sync-labs';
import { ContainerMediaProcessor } from '../services/media/container';
import { createDialogueSeparationProvider } from '../services/separation/config';
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
        translations: new SegmentTranslationRepository(this.env.DB),
        exports: new ProjectExportRepository(this.env.DB),
        speakers: new SpeakerRepository(this.env.DB),
        stems: new AudioStemRepository(this.env.DB),
        separation: createDialogueSeparationProvider(this.env),
        providerMediaGrants: new ProviderMediaGrantRepository(this.env.DB),
        lipSync: new SyncLabsLipSyncProvider({
          apiKey: qualifiedSyncLabsApiKey(
            this.env.SYNC_API_KEY,
            this.env.SYNC_LIPSYNC_QUALIFIED,
          ),
        }),
        makeProviderMediaToken: createProviderMediaToken,
        providerMediaOrigin: 'https://yupvox.qs3d.site',
        fetchImpl: fetch,
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
