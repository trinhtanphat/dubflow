import type { ProjectStatus } from '../db/projects';
import type { UsageStore } from '../db/usage';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import type { VoiceGenerateInput } from '../services/voice/types';
import { JobCancelledError, assertJobActive, isJobCancelledError } from './jobCancellation';

export type ZeroContainerExportParams = {
  projectId: string;
  userId: string;
  jobId: string;
  requestId?: string;
};

type ZeroContainerProject = {
  id: string;
  sourceObjectKey?: string | null;
  durationMs?: number | null;
};

type ZeroContainerSegment = {
  id: string;
  speakerId?: string | null;
  startMs: number;
  endMs: number;
  translatedText: string;
  voiceStatus: string;
  dubbedObjectKey?: string | null;
};

type ZeroContainerSpeaker = {
  id: string;
  voiceProvider?: string | null;
  voiceId?: string | null;
};

export type ZeroContainerExportDeps = {
  projects: {
    getByIdForUser(projectId: string, userId: string): Promise<ZeroContainerProject | null>;
    setStatus(projectId: string, userId: string, status: ProjectStatus): Promise<void>;
    setExportObject(projectId: string, userId: string, objectKey: string): Promise<void>;
  };
  jobs: {
    getForProject(projectId: string, jobId: string, userId: string): Promise<{ status: string; retryCount: number } | null>;
    setProgress(jobId: string, progress: number, stage: string): Promise<void>;
    fail(jobId: string, code: string, message: string): Promise<void>;
    complete(jobId: string, status?: string): Promise<void>;
  };
  segments: {
    list(projectId: string, userId: string): Promise<ZeroContainerSegment[]>;
    setVoiceResult(projectId: string, segmentId: string, userId: string, objectKey: string): Promise<void>;
  };
  speakers?: {
    list(projectId: string, userId: string): Promise<ZeroContainerSpeaker[]>;
  };
  bucket: {
    put?(key: string, value: ArrayBuffer): Promise<unknown>;
  };
  voice: {
    generate(input: VoiceGenerateInput): Promise<unknown>;
  };
  soundtrack: {
    durationSeconds(objectKey: string): Promise<number>;
    storeSoundtrack(input: {
      projectId: string;
      targetLanguage: 'vi';
      exportId: 'legacy';
      durationMs: number;
      clips: Array<{ startMs: number; endMs: number; objectKey: string }>;
    }): Promise<string>;
  };
  publisher: {
    publishDubbedExport(input: {
      projectId: string;
      userId: string;
      sourceObjectKey: string;
      soundtrackObjectKey: string;
      targetLanguage: 'vi';
      exportId: 'legacy';
      exportObjectKey: string;
    }): Promise<{ exportObjectKey: string; audioTrackUid: string }>;
  };
  usage: Pick<UsageStore, 'record' | 'getByOperation'>;
  telemetry: TelemetrySink;
};

export interface ZeroContainerExportStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown export failure.';
}

function operationKey(jobId: string, retryCount: number, stage: string, item: string, provider: string): string {
  return `job:${jobId}:retry:${retryCount}:${stage}:${item}:${provider}`;
}

function voiceObjectKey(projectId: string, segmentId: string): string {
  return `projects/${projectId}/dubbed/${segmentId}.pcm`;
}

function speakerVoiceId(segment: ZeroContainerSegment, speakers: Map<string, ZeroContainerSpeaker>): string | undefined {
  const speakerId = segment.speakerId?.trim();
  if (!speakerId) return undefined;
  const speaker = speakers.get(speakerId);
  if (!speaker?.voiceId?.trim()) return undefined;
  if (speaker.voiceProvider && speaker.voiceProvider !== 'elevenlabs') {
    throw new Error(`Speaker ${speakerId} uses unsupported voice provider ${speaker.voiceProvider}.`);
  }
  return speaker.voiceId.trim();
}

async function measuredVoiceSeconds(deps: ZeroContainerExportDeps, objectKey: string): Promise<number> {
  const seconds = await deps.soundtrack.durationSeconds(objectKey);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Generated voice duration is invalid.');
  return seconds;
}

export async function runZeroContainerExportPipeline(
  params: ZeroContainerExportParams,
  deps: ZeroContainerExportDeps,
  step: ZeroContainerExportStepLike,
): Promise<{ status: 'completed'; exportObjectKey: string }> {
  const ensureActive = () => assertJobActive(deps.jobs as never, params.projectId, params.jobId, params.userId);
  try {
    const project = await step.do('authorize zero-container export project', () =>
      deps.projects.getByIdForUser(params.projectId, params.userId),
    );
    if (!project) throw new Error('Project not found.');
    if (!project.sourceObjectKey) throw new Error('Project source media is missing.');
    const durationMs = Number(project.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Project duration is missing or invalid for render metering.');

    const job = await step.do('load zero-container export retry generation', () =>
      deps.jobs.getForProject(params.projectId, params.jobId, params.userId),
    );
    if (!job) throw new Error('Job not found.');
    if (job.status === 'cancelled') throw new JobCancelledError();
    if (!Number.isInteger(job.retryCount) || job.retryCount < 0) throw new Error('Job retry generation is invalid.');
    const retryCount = job.retryCount;

    const segments = await step.do('load zero-container export segments', () =>
      deps.segments.list(params.projectId, params.userId),
    );
    if (segments.length === 0) throw new Error('No translated segments are available for export.');
    const emptyTranslation = segments.find((segment) => !segment.translatedText.trim());
    if (emptyTranslation) throw new Error(`Segment ${emptyTranslation.id} has no translated text.`);

    const speakerRows = deps.speakers
      ? await step.do('load zero-container export speaker voices', () => deps.speakers!.list(params.projectId, params.userId))
      : [];
    const speakers = new Map(speakerRows.map((speaker) => [speaker.id, speaker]));

    await step.do('mark zero-container export processing', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'processing');
      await deps.jobs.setProgress(params.jobId, 0.05, 'generating_voice');
    });

    const clips: Array<{ startMs: number; endMs: number; objectKey: string }> = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      await step.do(`check cancellation before PCM voice ${segment.id}`, ensureActive);
      const expectedObjectKey = voiceObjectKey(params.projectId, segment.id);
      let objectKey = segment.voiceStatus === 'completed' && segment.dubbedObjectKey === expectedObjectKey
        ? expectedObjectKey
        : null;
      const ttsProvider = 'elevenlabs';
      const ttsKey = operationKey(params.jobId, retryCount, 'tts', segment.id, ttsProvider);
      const started = await step.do(`load PCM TTS started usage ${segment.id}`, () => deps.usage.getByOperation(ttsKey, 'started'));
      const completed = await step.do(`load PCM TTS completed usage ${segment.id}`, () => deps.usage.getByOperation(ttsKey, 'completed'));

      if (objectKey) {
        if (started && !completed) {
          await step.do(`recover PCM TTS usage ${segment.id}`, async () => {
            const units = await measuredVoiceSeconds(deps, objectKey!);
            await deps.usage.record({
              userId: params.userId,
              projectId: params.projectId,
              jobId: params.jobId,
              kind: 'tts_audio_second',
              units,
              provider: ttsProvider,
              phase: 'completed',
              operationKey: ttsKey,
            });
          });
        }
      } else {
        if (completed) throw new Error(`Segment ${segment.id} has completed TTS usage without a durable voice artifact.`);
        if (!deps.bucket.put) throw new Error('R2 put is unavailable for voice generation.');
        objectKey = expectedObjectKey;
        await step.do(`generate PCM voice ${segment.id}`, async () => {
          await deps.usage.record({
            userId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            kind: 'tts_audio_second',
            units: 0,
            provider: ttsProvider,
            phase: 'started',
            operationKey: ttsKey,
          });
          const text = segment.translatedText.trim();
          const voice = speakerVoiceId(segment, speakers);
          const voiceInput: VoiceGenerateInput = voice
            ? { text, language: 'vi', voice, outputFormat: 'pcm_24000' }
            : { text, language: 'vi', outputFormat: 'pcm_24000' };
          const generated = await withProviderTelemetry(deps.telemetry, {
            requestId: params.requestId,
            actorId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            operation: 'voice',
            provider: ttsProvider,
            errorCode: 'VOICE_PROVIDER_FAILED',
          }, () => deps.voice.generate(voiceInput));
          if (!(generated instanceof Response)) throw new Error('Voice provider returned an unsupported response.');
          if (!generated.ok) throw new Error(`Voice provider failed (${generated.status}).`);
          const audio = await generated.arrayBuffer();
          if (audio.byteLength === 0) throw new Error('Voice provider returned empty audio.');
          await deps.bucket.put!(objectKey!, audio);
          await deps.segments.setVoiceResult(params.projectId, segment.id, params.userId, objectKey!);
          const units = await measuredVoiceSeconds(deps, objectKey!);
          await deps.usage.record({
            userId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            kind: 'tts_audio_second',
            units,
            provider: ttsProvider,
            phase: 'completed',
            operationKey: ttsKey,
          });
        });
      }

      clips.push({ startMs: segment.startMs, endMs: segment.endMs, objectKey });
      const progress = 0.1 + ((index + 1) / segments.length) * 0.55;
      await step.do(`persist PCM voice progress ${segment.id}`, () =>
        deps.jobs.setProgress(params.jobId, progress, 'generating_voice'),
      );
    }

    await step.do('check cancellation before soundtrack publish', ensureActive);
    await step.do('mark zero-container render stage', () => deps.jobs.setProgress(params.jobId, 0.72, 'rendering_export'));
    const soundtrackObjectKey = await step.do('stream dubbed PCM soundtrack', () => deps.soundtrack.storeSoundtrack({
      projectId: params.projectId,
      targetLanguage: 'vi',
      exportId: 'legacy',
      durationMs,
      clips,
    }));

    const renderProvider = 'cloudflare-stream';
    const renderKey = operationKey(params.jobId, retryCount, 'render', 'final', renderProvider);
    const expectedExportObjectKey = `projects/${params.projectId}/export/dubbed.mp4`;
    const rendered = await step.do('publish zero-container dubbed media', async () => {
      const common = {
        userId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        kind: 'render_second' as const,
        units: durationMs / 1000,
        provider: renderProvider,
        operationKey: renderKey,
      };
      await deps.usage.record({ ...common, phase: 'started' });
      const result = await withProviderTelemetry(deps.telemetry, {
        requestId: params.requestId,
        actorId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        operation: 'render',
        provider: renderProvider,
        errorCode: 'MEDIA_RENDER_FAILED',
      }, () => deps.publisher.publishDubbedExport({
        projectId: params.projectId,
        userId: params.userId,
        sourceObjectKey: project.sourceObjectKey!,
        soundtrackObjectKey,
        targetLanguage: 'vi',
        exportId: 'legacy',
        exportObjectKey: expectedExportObjectKey,
      }));
      if (result.exportObjectKey !== expectedExportObjectKey) {
        throw new Error('Stream publisher returned an invalid export object key.');
      }
      await deps.usage.record({ ...common, phase: 'completed' });
      return result;
    });

    await step.do('check cancellation before zero-container export completion', ensureActive);
    await step.do('complete zero-container export', async () => {
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
        // Preserve cancellation.
      }
      throw error;
    }
    const message = errorMessage(error);
    try {
      await deps.jobs.fail(params.jobId, 'EXPORT_FAILED', message);
      await deps.projects.setStatus(params.projectId, params.userId, 'needs_review');
    } catch {
      // Preserve the original export failure.
    }
    throw error;
  }
}
