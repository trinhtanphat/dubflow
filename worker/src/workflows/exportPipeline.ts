import type { ProjectStatus } from '../db/projects';
import type { DubbingJob, JobStore } from '../db/jobs';
import type { UsageStore } from '../db/usage';
import type { VoiceGenerateInput } from '../services/voice/types';
import { assertJobActive, isJobCancelledError } from './jobCancellation';

export type ExportWorkflowParams = { projectId: string; userId: string; jobId: string };

export type ExportClip = {
  segmentId: string;
  startMs: number;
  endMs: number;
  objectKey: string;
};

export interface ExportWorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

type ExportProject = {
  id: string;
  sourceObjectKey?: string | null;
  durationMs?: number | null;
};

type ExportSegment = {
  id: string;
  speakerId?: string | null;
  startMs: number;
  endMs: number;
  translatedText: string;
  voiceStatus: string;
  dubbedObjectKey?: string | null;
};

type ExportSpeaker = {
  id: string;
  voiceProvider?: string | null;
  voiceId?: string | null;
};

type ExportJobs = {
  getForProject(
    projectId: string,
    jobId: string,
    userId: string,
  ): Promise<Pick<DubbingJob, 'status' | 'retryCount'> | null>;
} & Pick<JobStore, 'setProgress' | 'fail' | 'complete'>;

type ExportUsage = Pick<UsageStore, 'record' | 'getByOperation'>;

export type ExportPipelineDeps = {
  projects: {
    getByIdForUser(projectId: string, userId: string): Promise<ExportProject | null>;
    setStatus(projectId: string, userId: string, status: ProjectStatus): Promise<void>;
    setExportObject(projectId: string, userId: string, objectKey: string): Promise<void>;
  };
  jobs: ExportJobs;
  segments: {
    list(projectId: string, userId: string): Promise<ExportSegment[]>;
    setVoiceResult(projectId: string, segmentId: string, userId: string, objectKey: string): Promise<void>;
  };
  speakers?: {
    list(projectId: string, userId: string): Promise<ExportSpeaker[]>;
  };
  bucket: {
    put?(key: string, value: ArrayBuffer): Promise<unknown>;
  };
  voice: {
    generate(input: VoiceGenerateInput): Promise<unknown>;
  };
  media: {
    probe(objectKey: string): Promise<{ durationMs: number }>;
    renderExport(projectId: string, sourceObjectKey: string, clips: ExportClip[]): Promise<{ exportObjectKey: string }>;
  };
  usage: ExportUsage;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown export failure.';
}

function audioObjectKey(projectId: string, segmentId: string): string {
  return `projects/${projectId}/dubbed/${segmentId}.mp3`;
}

function usageKey(jobId: string, retryCount: number, stage: string, item: string, provider: string): string {
  return `job:${jobId}:retry:${retryCount}:${stage}:${item}:${provider}`;
}

function speakerVoiceId(segment: ExportSegment, speakers: Map<string, ExportSpeaker>): string | undefined {
  const speakerId = segment.speakerId?.trim();
  if (!speakerId) return undefined;
  const speaker = speakers.get(speakerId);
  if (!speaker?.voiceId?.trim()) return undefined;
  if (speaker.voiceProvider && speaker.voiceProvider !== 'elevenlabs') {
    throw new Error(`Speaker ${speakerId} uses unsupported voice provider ${speaker.voiceProvider}.`);
  }
  return speaker.voiceId.trim();
}

function positiveDurationMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} duration is invalid.`);
  return value;
}

export async function runExportPipeline(
  params: ExportWorkflowParams,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): Promise<{ status: 'completed'; exportObjectKey: string }> {
  const ensureActive = () => assertJobActive(deps.jobs, params.projectId, params.jobId, params.userId);
  try {
    const project = await step.do('authorize export project', async () =>
      deps.projects.getByIdForUser(params.projectId, params.userId),
    );
    if (!project) throw new Error('Project not found.');
    if (!project.sourceObjectKey) throw new Error('Project source media is missing.');

    const job = await step.do('load export usage retry generation', async () =>
      deps.jobs.getForProject(params.projectId, params.jobId, params.userId),
    );
    if (!job) throw new Error('Job not found.');
    if (!Number.isInteger(job.retryCount) || job.retryCount < 0) throw new Error('Job retry generation is invalid.');
    const retryCount = job.retryCount;

    const segments = await step.do('load translated export segments', async () =>
      deps.segments.list(params.projectId, params.userId),
    );
    if (segments.length === 0) throw new Error('No translated segments are available for export.');
    const emptyTranslation = segments.find((segment) => !segment.translatedText.trim());
    if (emptyTranslation) throw new Error(`Segment ${emptyTranslation.id} has no translated text.`);

    const speakerRows = deps.speakers
      ? await step.do('load export speaker voices', async () => deps.speakers!.list(params.projectId, params.userId))
      : [];
    const speakers = new Map(speakerRows.map((speaker) => [speaker.id, speaker]));

    await step.do('check cancellation before export processing', ensureActive);
    await step.do('mark export processing', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'processing');
      await deps.jobs.setProgress(params.jobId, 0.05, 'generating_voice');
    });

    const clips: ExportClip[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      await step.do(`check cancellation before voice ${segment.id}`, ensureActive);
      let objectKey = segment.voiceStatus === 'completed' && segment.dubbedObjectKey
        ? segment.dubbedObjectKey
        : null;
      const ttsOperationKey = usageKey(params.jobId, retryCount, 'tts', segment.id, 'elevenlabs');

      if (!objectKey) {
        objectKey = audioObjectKey(params.projectId, segment.id);
        await step.do(`generate voice ${segment.id}`, async () => {
          if (!deps.bucket.put) throw new Error('R2 put is unavailable for voice generation.');
          await deps.usage.record({
            userId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            kind: 'tts_audio_second',
            units: 0,
            provider: 'elevenlabs',
            phase: 'started',
            operationKey: ttsOperationKey,
          });
          const text = segment.translatedText.trim();
          const voice = speakerVoiceId(segment, speakers);
          const input: VoiceGenerateInput = voice
            ? { text, language: 'vi', voice }
            : { text, language: 'vi' };
          const generated = await deps.voice.generate(input);
          if (!(generated instanceof Response)) throw new Error('Voice provider returned an unsupported response.');
          if (!generated.ok) throw new Error(`Voice provider failed (${generated.status}).`);
          const audio = await generated.arrayBuffer();
          if (audio.byteLength === 0) throw new Error('Voice provider returned empty audio.');
          await deps.bucket.put(objectKey!, audio);
          await deps.segments.setVoiceResult(params.projectId, segment.id, params.userId, objectKey!);
        });

        await step.do(`complete voice usage ${segment.id}`, async () => {
          const metadata = await deps.media.probe(objectKey!);
          const durationMs = positiveDurationMs(metadata.durationMs, `Generated voice ${segment.id}`);
          await deps.usage.record({
            userId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            kind: 'tts_audio_second',
            units: durationMs / 1000,
            provider: 'elevenlabs',
            phase: 'completed',
            operationKey: ttsOperationKey,
          });
        });
      } else {
        const started = await step.do(`read voice usage start ${segment.id}`, async () =>
          deps.usage.getByOperation(ttsOperationKey, 'started'),
        );
        if (started) {
          const completed = await step.do(`read voice usage completion ${segment.id}`, async () =>
            deps.usage.getByOperation(ttsOperationKey, 'completed'),
          );
          if (!completed) {
            await step.do(`recover voice usage ${segment.id}`, async () => {
              const metadata = await deps.media.probe(objectKey!);
              const durationMs = positiveDurationMs(metadata.durationMs, `Generated voice ${segment.id}`);
              await deps.usage.record({
                userId: params.userId,
                projectId: params.projectId,
                jobId: params.jobId,
                kind: 'tts_audio_second',
                units: durationMs / 1000,
                provider: 'elevenlabs',
                phase: 'completed',
                operationKey: ttsOperationKey,
              });
            });
          }
        }
      }

      clips.push({
        segmentId: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        objectKey,
      });

      const progress = 0.1 + ((index + 1) / segments.length) * 0.55;
      await step.do(`persist voice progress ${segment.id}`, async () =>
        deps.jobs.setProgress(params.jobId, progress, 'generating_voice'),
      );
    }

    await step.do('check cancellation before export render', ensureActive);
    await step.do('mark render stage', async () =>
      deps.jobs.setProgress(params.jobId, 0.72, 'rendering_export'),
    );

    const projectDurationMs = positiveDurationMs(project.durationMs ?? Number.NaN, 'Project');
    const renderUnits = projectDurationMs / 60000;
    const renderOperationKey = usageKey(params.jobId, retryCount, 'render', 'final', 'ffmpeg-container');
    const rendered = await step.do('render final dubbed media', async () => {
      await deps.usage.record({
        userId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        kind: 'render_minute',
        units: renderUnits,
        provider: 'ffmpeg-container',
        phase: 'started',
        operationKey: renderOperationKey,
      });
      return deps.media.renderExport(params.projectId, project.sourceObjectKey!, clips);
    });
    if (!rendered.exportObjectKey?.startsWith(`projects/${params.projectId}/export/`)) {
      throw new Error('Media processor returned an invalid export object key.');
    }
    await step.do('complete render usage', async () => {
      await deps.usage.record({
        userId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        kind: 'render_minute',
        units: renderUnits,
        provider: 'ffmpeg-container',
        phase: 'completed',
        operationKey: renderOperationKey,
      });
    });

    await step.do('check cancellation before export publish', ensureActive);
    await step.do('publish final export', async () => {
      await deps.projects.setExportObject(params.projectId, params.userId, rendered.exportObjectKey);
      await deps.projects.setStatus(params.projectId, params.userId, 'completed');
      await deps.jobs.complete(params.jobId);
    });

    return { status: 'completed', exportObjectKey: rendered.exportObjectKey };
  } catch (error) {
    if (isJobCancelledError(error)) {
      try {
        await deps.projects.setStatus(params.projectId, params.userId, 'cancelled');
      } catch {
        // Preserve the cancellation error if the project status write also fails.
      }
      throw error;
    }

    const message = errorMessage(error);
    try {
      await deps.jobs.fail(params.jobId, 'EXPORT_FAILED', message);
      await deps.projects.setStatus(params.projectId, params.userId, 'needs_review');
    } catch {
      // Preserve the original export failure if durable failure recording also fails.
    }
    throw error;
  }
}
