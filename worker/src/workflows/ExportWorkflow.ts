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
import { PcmSoundtrackService } from '../services/media/pcm-soundtrack';
import { R2Mp4RemuxPublisher } from '../services/media/mp4-remux';
import { UnavailableDialogueSeparationProvider } from '../services/separation/unavailable';
import { createVoiceProvider } from '../services/voice/provider';
import { runExportPipeline, type ExportWorkflowParams } from './exportPipeline';

export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportWorkflowParams> {
  async run(event: WorkflowEvent<ExportWorkflowParams>, step: WorkflowStep) {
    const subtitleOnly = event.payload.output === 'subtitles';

    const projects = new ProjectRepository(this.env.DB);
    const exports = new ProjectExportRepository(this.env.DB);
    const soundtrack = new PcmSoundtrackService(this.env.MEDIA);
    const publisher = subtitleOnly ? undefined : new R2Mp4RemuxPublisher({
      bucket: this.env.MEDIA,
    });

    return runExportPipeline(
      event.payload,
      {
        projects,
        jobs: new JobRepository(this.env.DB),
        segments: new SegmentRepository(this.env.DB),
        translations: new SegmentTranslationRepository(this.env.DB),
        exports,
        speakers: new SpeakerRepository(this.env.DB),
        stems: new AudioStemRepository(this.env.DB),
        separation: new UnavailableDialogueSeparationProvider(),
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
        voice: createVoiceProvider(this.env),
        soundtrack,
        publisher,
        usage: new UsageRepository(this.env.DB),
        telemetry: createTelemetry(this.env),
      },
      step,
    );
  }
}
