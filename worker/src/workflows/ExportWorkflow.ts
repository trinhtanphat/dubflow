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
import { SyncLabsLipSyncProvider } from '../services/lipsync/sync-labs';
import { PcmSoundtrackService } from '../services/media/pcm-soundtrack';
import { StreamMediaService } from '../services/media/stream';
import { UnavailableDialogueSeparationProvider } from '../services/separation/unavailable';
import { ElevenLabsVoiceProvider } from '../services/voice/elevenlabs';
import { runExportPipeline, type ExportWorkflowParams } from './exportPipeline';

export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportWorkflowParams> {
  async run(event: WorkflowEvent<ExportWorkflowParams>, step: WorkflowStep) {
    const subtitleOnly = event.payload.output === 'subtitles';
    if (!subtitleOnly && !this.env.STREAM) {
      throw new Error('STREAM_BINDING_UNAVAILABLE: Cloudflare Stream binding is unavailable.');
    }

    const projects = new ProjectRepository(this.env.DB);
    const exports = new ProjectExportRepository(this.env.DB);
    const soundtrack = new PcmSoundtrackService(this.env.MEDIA);
    const publisher = subtitleOnly ? undefined : new StreamMediaService({
      projects,
      exportAssets: exports,
      stream: this.env.STREAM!,
      bucket: this.env.MEDIA,
      publicOrigin: this.env.PUBLIC_ORIGIN ?? '',
      signingSecret: this.env.STREAM_SOURCE_SIGNING_SECRET ?? '',
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: this.env.CLOUDFLARE_STREAM_API_TOKEN,
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
        lipSync: new SyncLabsLipSyncProvider({ apiKey: this.env.SYNC_API_KEY }),
        makeProviderMediaToken: createProviderMediaToken,
        providerMediaOrigin: 'https://yupvox.qs3d.site',
        fetchImpl: fetch,
        bucket: this.env.MEDIA,
        voice: new ElevenLabsVoiceProvider(
          this.env.ELEVENLABS_API_KEY ?? '',
          { defaultVoiceId: this.env.ELEVENLABS_DEFAULT_VOICE_ID },
        ),
        soundtrack,
        publisher,
        usage: new UsageRepository(this.env.DB),
        telemetry: createTelemetry(this.env),
      },
      step,
    );
  }
}
