import type { R2PutOptionsLike, R2UploadValue } from '../cloudflare/r2';
import type { ProjectExportRepository } from '../db/project-exports';
import type { ProviderMediaGrantRepository } from '../db/provider-media-grants';
import type { ProjectStatus } from '../db/projects';
import type { UsageStore } from '../db/usage';
import { parseDubbedAudioMode, type DubbedAudioMode } from '../domain/audio-mode';
import type { ExportOutput, TargetLanguage } from '../domain/language';
import { isTargetLanguage } from '../domain/language';
import { parseVisualMode, type VisualMode } from '../domain/visual-mode';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import { createProviderMediaToken } from '../security/provider-media-token';
import { LipSyncProviderError, type LipSyncProvider } from '../services/lipsync/types';
import type { VoiceGenerateInput } from '../services/voice/types';
import { JobCancelledError, assertJobActive, isJobCancelledError } from './jobCancellation';
import { runVisualLipSync } from './visualLipSync';

export type ZeroContainerExportParams = {
  projectId: string;
  userId: string;
  jobId: string;
  exportId?: string;
  targetLanguage?: TargetLanguage;
  output?: ExportOutput;
  audioMode?: DubbedAudioMode;
  visualMode?: VisualMode;
  requestId?: string;
};

type NormalizedZeroParams = {
  projectId: string;
  userId: string;
  jobId: string;
  requestId?: string;
  modern: boolean;
  exportId: string | null;
  targetLanguage: TargetLanguage;
  output: 'dubbed';
  audioMode: 'dubbed_only';
  visualMode: VisualMode;
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
  version?: number;
};

type ZeroContainerVariant = {
  segmentId: string;
  targetLanguage: TargetLanguage;
  translatedText: string;
  translationStatus: string;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
};

type ZeroContainerWorkItem = {
  id: string;
  speakerId?: string | null;
  startMs: number;
  endMs: number;
  translatedText: string;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
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
  translations?: {
    list(projectId: string, userId: string, targetLanguage: TargetLanguage): Promise<ZeroContainerVariant[]>;
    setVoiceResult(
      projectId: string,
      segmentId: string,
      userId: string,
      targetLanguage: TargetLanguage,
      objectKey: string,
    ): Promise<void>;
  };
  exports?: Pick<ProjectExportRepository, 'get' | 'complete' | 'setLipSyncState' | 'fail'>;
  speakers?: {
    list(projectId: string, userId: string): Promise<ZeroContainerSpeaker[]>;
  };
  providerMediaGrants?: Pick<ProviderMediaGrantRepository, 'create' | 'expire'>;
  lipSync?: LipSyncProvider;
  makeProviderMediaToken?: typeof createProviderMediaToken;
  providerMediaOrigin?: string;
  fetchImpl?: typeof fetch;
  bucket: {
    put?(key: string, value: R2UploadValue, options?: R2PutOptionsLike): Promise<unknown>;
  };
  voice: {
    generate(input: VoiceGenerateInput): Promise<unknown>;
  };
  soundtrack: {
    durationSeconds(objectKey: string): Promise<number>;
    storeSoundtrack(input: {
      projectId: string;
      targetLanguage: TargetLanguage;
      exportId: string;
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
      targetLanguage: TargetLanguage;
      exportId: string;
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

function normalizeParams(params: ZeroContainerExportParams): NormalizedZeroParams {
  const modernFieldPresent = params.exportId !== undefined
    || params.targetLanguage !== undefined
    || params.output !== undefined
    || params.audioMode !== undefined
    || params.visualMode !== undefined;
  if (!modernFieldPresent) {
    return {
      projectId: params.projectId,
      userId: params.userId,
      jobId: params.jobId,
      requestId: params.requestId,
      modern: false,
      exportId: null,
      targetLanguage: 'vi',
      output: 'dubbed',
      audioMode: 'dubbed_only',
      visualMode: 'standard',
    };
  }

  const audioMode = parseDubbedAudioMode(params.audioMode);
  const visualMode = parseVisualMode(params.visualMode);
  if (
    typeof params.exportId !== 'string' || !params.exportId.trim()
    || !isTargetLanguage(params.targetLanguage)
    || params.output !== 'dubbed'
    || audioMode !== 'dubbed_only'
    || !visualMode
  ) {
    throw new Error('Zero-container export supports dubbed_only dubbed exports with a valid visual mode only.');
  }
  return {
    projectId: params.projectId,
    userId: params.userId,
    jobId: params.jobId,
    requestId: params.requestId,
    modern: true,
    exportId: params.exportId,
    targetLanguage: params.targetLanguage,
    output: 'dubbed',
    audioMode: 'dubbed_only',
    visualMode,
  };
}

function operationKey(jobId: string, retryCount: number, stage: string, item: string, provider: string): string {
  return `job:${jobId}:retry:${retryCount}:${stage}:${item}:${provider}`;
}

function legacyVoiceObjectKey(projectId: string, segmentId: string): string {
  return `projects/${projectId}/dubbed/${segmentId}.pcm`;
}

function targetVoiceObjectKey(
  projectId: string,
  targetLanguage: TargetLanguage,
  segmentId: string,
  version: number,
): string {
  return `projects/${projectId}/voices/${targetLanguage}/${segmentId}/${version}.pcm`;
}

function legacyWorkItems(segments: ZeroContainerSegment[]): ZeroContainerWorkItem[] {
  return segments.map((segment) => ({
    id: segment.id,
    speakerId: segment.speakerId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    translatedText: segment.translatedText,
    voiceStatus: segment.voiceStatus,
    dubbedObjectKey: segment.dubbedObjectKey ?? null,
    version: Number.isInteger(segment.version) && Number(segment.version) > 0 ? Number(segment.version) : 1,
  }));
}

function targetWorkItems(
  sourceSegments: ZeroContainerSegment[],
  variants: ZeroContainerVariant[],
  targetLanguage: TargetLanguage,
): ZeroContainerWorkItem[] {
  if (variants.length !== sourceSegments.length) {
    throw new Error(`Translation variants for ${targetLanguage} are incomplete.`);
  }
  const bySegment = new Map<string, ZeroContainerVariant>();
  for (const variant of variants) {
    if (variant.targetLanguage !== targetLanguage || bySegment.has(variant.segmentId)) {
      throw new Error(`Translation variants for ${targetLanguage} are structurally invalid.`);
    }
    bySegment.set(variant.segmentId, variant);
  }
  const sourceIds = new Set(sourceSegments.map((segment) => segment.id));
  if ([...bySegment.keys()].some((id) => !sourceIds.has(id))) {
    throw new Error(`Translation variants for ${targetLanguage} include an unknown segment.`);
  }
  return sourceSegments.map((segment) => {
    const variant = bySegment.get(segment.id);
    if (!variant || variant.translationStatus !== 'completed' || !variant.translatedText.trim()) {
      throw new Error(`Segment ${segment.id} has no completed ${targetLanguage} translation.`);
    }
    if (!Number.isInteger(variant.version) || variant.version < 1) {
      throw new Error(`Segment ${segment.id} has an invalid ${targetLanguage} version.`);
    }
    return {
      id: segment.id,
      speakerId: segment.speakerId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      translatedText: variant.translatedText,
      voiceStatus: variant.voiceStatus,
      dubbedObjectKey: variant.dubbedObjectKey,
      version: variant.version,
    };
  });
}

function speakerVoiceId(segment: ZeroContainerWorkItem, speakers: Map<string, ZeroContainerSpeaker>): string | undefined {
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
  inputParams: ZeroContainerExportParams,
  deps: ZeroContainerExportDeps,
  step: ZeroContainerExportStepLike,
): Promise<{ status: 'completed'; exportObjectKey: string }> {
  let params: NormalizedZeroParams | null = null;
  let standardPublished = false;
  try {
    params = normalizeParams(inputParams);
    const ensureActive = () => assertJobActive(deps.jobs as never, params!.projectId, params!.jobId, params!.userId);

    const project = await step.do('authorize zero-container export project', () =>
      deps.projects.getByIdForUser(params!.projectId, params!.userId),
    );
    if (!project) throw new Error('Project not found.');
    if (!project.sourceObjectKey) throw new Error('Project source media is missing.');
    const durationMs = Number(project.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Project duration is missing or invalid for render metering.');

    const job = await step.do('load zero-container export retry generation', () =>
      deps.jobs.getForProject(params!.projectId, params!.jobId, params!.userId),
    );
    if (!job) throw new Error('Job not found.');
    if (job.status === 'cancelled') throw new JobCancelledError();
    if (!Number.isInteger(job.retryCount) || job.retryCount < 0) throw new Error('Job retry generation is invalid.');
    const retryCount = job.retryCount;

    const sourceSegments = await step.do('load zero-container export segments', () =>
      deps.segments.list(params!.projectId, params!.userId),
    );
    if (sourceSegments.length === 0) throw new Error('No translated segments are available for export.');

    let segments: ZeroContainerWorkItem[];
    if (params.modern) {
      if (!deps.translations || !deps.exports) throw new Error('Target-language export repositories are unavailable.');
      const variants = await step.do('load target-language zero-container translations', () =>
        deps.translations!.list(params!.projectId, params!.userId, params!.targetLanguage),
      );
      segments = targetWorkItems(sourceSegments, variants, params.targetLanguage);
    } else {
      segments = legacyWorkItems(sourceSegments);
      const emptyTranslation = segments.find((segment) => !segment.translatedText.trim());
      if (emptyTranslation) throw new Error(`Segment ${emptyTranslation.id} has no translated text.`);
    }

    const speakerRows = deps.speakers
      ? await step.do('load zero-container export speaker voices', () => deps.speakers!.list(params!.projectId, params!.userId))
      : [];
    const speakers = new Map(speakerRows.map((speaker) => [speaker.id, speaker]));

    if (!params.modern) {
      await step.do('mark zero-container export processing', async () => {
        await deps.projects.setStatus(params!.projectId, params!.userId, 'processing');
        await deps.jobs.setProgress(params!.jobId, 0.05, 'generating_voice');
      });
    } else {
      await step.do('mark zero-container export processing', () =>
        deps.jobs.setProgress(params!.jobId, 0.05, 'generating_voice'),
      );
    }

    const clips: Array<{ startMs: number; endMs: number; objectKey: string }> = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      await step.do(`check cancellation before PCM voice ${segment.id}`, ensureActive);
      const expectedObjectKey = params.modern
        ? targetVoiceObjectKey(params.projectId, params.targetLanguage, segment.id, segment.version)
        : legacyVoiceObjectKey(params.projectId, segment.id);
      let objectKey = segment.voiceStatus === 'completed' && segment.dubbedObjectKey === expectedObjectKey
        ? expectedObjectKey
        : null;
      const ttsProvider = 'elevenlabs';
      const ttsItem = params.modern ? `${params.targetLanguage}:${segment.id}` : segment.id;
      const ttsKey = operationKey(params.jobId, retryCount, 'tts', ttsItem, ttsProvider);
      const started = await step.do(`load PCM TTS started usage ${segment.id}`, () => deps.usage.getByOperation(ttsKey, 'started'));
      const completed = await step.do(`load PCM TTS completed usage ${segment.id}`, () => deps.usage.getByOperation(ttsKey, 'completed'));

      if (objectKey) {
        if (started && !completed) {
          await step.do(`recover PCM TTS usage ${segment.id}`, async () => {
            const units = await measuredVoiceSeconds(deps, objectKey!);
            await deps.usage.record({
              userId: params!.userId,
              projectId: params!.projectId,
              jobId: params!.jobId,
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
            userId: params!.userId,
            projectId: params!.projectId,
            jobId: params!.jobId,
            kind: 'tts_audio_second',
            units: 0,
            provider: ttsProvider,
            phase: 'started',
            operationKey: ttsKey,
          });
          const text = segment.translatedText.trim();
          const voice = speakerVoiceId(segment, speakers);
          const voiceInput: VoiceGenerateInput = voice
            ? { text, language: params!.targetLanguage, voice, outputFormat: 'pcm_24000' }
            : { text, language: params!.targetLanguage, outputFormat: 'pcm_24000' };
          const generated = await withProviderTelemetry(deps.telemetry, {
            requestId: params!.requestId,
            actorId: params!.userId,
            projectId: params!.projectId,
            jobId: params!.jobId,
            operation: 'voice',
            provider: ttsProvider,
            errorCode: 'VOICE_PROVIDER_FAILED',
          }, () => deps.voice.generate(voiceInput));
          if (!(generated instanceof Response)) throw new Error('Voice provider returned an unsupported response.');
          if (!generated.ok) throw new Error(`Voice provider failed (${generated.status}).`);
          const audio = await generated.arrayBuffer();
          if (audio.byteLength === 0) throw new Error('Voice provider returned empty audio.');
          await deps.bucket.put!(objectKey!, audio);
          if (params!.modern) {
            await deps.translations!.setVoiceResult(
              params!.projectId,
              segment.id,
              params!.userId,
              params!.targetLanguage,
              objectKey!,
            );
          } else {
            await deps.segments.setVoiceResult(params!.projectId, segment.id, params!.userId, objectKey!);
          }
          const units = await measuredVoiceSeconds(deps, objectKey!);
          await deps.usage.record({
            userId: params!.userId,
            projectId: params!.projectId,
            jobId: params!.jobId,
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
        deps.jobs.setProgress(params!.jobId, progress, 'generating_voice'),
      );
    }

    await step.do('check cancellation before soundtrack publish', ensureActive);
    await step.do('mark zero-container render stage', () => deps.jobs.setProgress(params!.jobId, 0.72, 'rendering_export'));
    const exportId = params.modern ? params.exportId! : 'legacy';
    const soundtrackObjectKey = await step.do('stream dubbed PCM soundtrack', () => deps.soundtrack.storeSoundtrack({
      projectId: params!.projectId,
      targetLanguage: params!.targetLanguage,
      exportId,
      durationMs,
      clips,
    }));
    const expectedSoundtrackObjectKey = `projects/${params.projectId}/soundtracks/${params.targetLanguage}/${exportId}.wav`;
    if (soundtrackObjectKey !== expectedSoundtrackObjectKey) {
      throw new Error('Soundtrack service returned an invalid object key.');
    }

    const renderProvider = 'cloudflare-stream';
    const renderItem = params.modern ? `${params.targetLanguage}:final` : 'final';
    const renderKey = operationKey(params.jobId, retryCount, 'render', renderItem, renderProvider);
    const expectedExportObjectKey = params.modern
      ? `projects/${params.projectId}/exports/${params.targetLanguage}/${params.exportId}.mp4`
      : `projects/${params.projectId}/export/dubbed.mp4`;
    const rendered = await step.do('publish zero-container dubbed media', async () => {
      const common = {
        userId: params!.userId,
        projectId: params!.projectId,
        jobId: params!.jobId,
        kind: 'render_second' as const,
        units: durationMs / 1000,
        provider: renderProvider,
        operationKey: renderKey,
      };
      await deps.usage.record({ ...common, phase: 'started' });
      const result = await withProviderTelemetry(deps.telemetry, {
        requestId: params!.requestId,
        actorId: params!.userId,
        projectId: params!.projectId,
        jobId: params!.jobId,
        operation: 'render',
        provider: renderProvider,
        errorCode: 'MEDIA_RENDER_FAILED',
      }, () => deps.publisher.publishDubbedExport({
        projectId: params!.projectId,
        userId: params!.userId,
        sourceObjectKey: project.sourceObjectKey!,
        soundtrackObjectKey,
        targetLanguage: params!.targetLanguage,
        exportId,
        exportObjectKey: expectedExportObjectKey,
      }));
      if (result.exportObjectKey !== expectedExportObjectKey) {
        throw new Error('Stream publisher returned an invalid export object key.');
      }
      await deps.usage.record({ ...common, phase: 'completed' });
      return result;
    });

    await step.do('check cancellation before zero-container export completion', ensureActive);
    await step.do('publish standard zero-container export', async () => {
      if (params!.modern) {
        await deps.exports!.complete(
          params!.projectId,
          params!.exportId!,
          params!.userId,
          { exportObjectKey: rendered.exportObjectKey },
        );
        standardPublished = true;
        if (params!.targetLanguage === 'vi') {
          await deps.projects.setExportObject(params!.projectId, params!.userId, rendered.exportObjectKey);
        }
      } else {
        await deps.projects.setExportObject(params!.projectId, params!.userId, rendered.exportObjectKey);
        await deps.projects.setStatus(params!.projectId, params!.userId, 'completed');
      }
    });

    if (params.modern && params.visualMode === 'lip_sync') {
      if (!params.exportId || !deps.exports || !deps.providerMediaGrants || !deps.lipSync) {
        throw new LipSyncProviderError('LIP_SYNC_UNAVAILABLE', 'Visual lip-sync orchestration is unavailable.');
      }
      await step.do('mark visual lip-sync stage', () => deps.jobs.setProgress(params!.jobId, 0.82, 'processing_visual_lip_sync'));
      await runVisualLipSync({
        projectId: params.projectId,
        userId: params.userId,
        jobId: params.jobId,
        retryCount,
        requestId: params.requestId,
        targetLanguage: params.targetLanguage,
        exportId: params.exportId,
        standardObjectKey: rendered.exportObjectKey,
        soundtrackObjectKey,
        durationMs,
      }, {
        exports: deps.exports,
        providerMediaGrants: deps.providerMediaGrants,
        lipSync: deps.lipSync,
        bucket: deps.bucket,
        usage: deps.usage,
        telemetry: deps.telemetry,
        makeProviderMediaToken: deps.makeProviderMediaToken,
        providerMediaOrigin: deps.providerMediaOrigin,
        fetchImpl: deps.fetchImpl,
      }, step, ensureActive);
      await step.do('mark visual lip-sync complete', () => deps.jobs.setProgress(params!.jobId, 0.98, 'publishing_visual_lip_sync'));
    }

    await step.do('complete zero-container export job', () => deps.jobs.complete(params!.jobId));
    return { status: 'completed', exportObjectKey: rendered.exportObjectKey };
  } catch (error) {
    const effective = params ?? {
      projectId: inputParams.projectId,
      userId: inputParams.userId,
      jobId: inputParams.jobId,
      requestId: inputParams.requestId,
      modern: false,
      exportId: null,
      targetLanguage: 'vi' as const,
      output: 'dubbed' as const,
      audioMode: 'dubbed_only' as const,
      visualMode: 'standard' as const,
    };
    if (isJobCancelledError(error)) {
      if (!effective.modern) {
        try {
          await deps.projects.setStatus(effective.projectId, effective.userId, 'cancelled');
        } catch {
          // Preserve cancellation.
        }
      }
      throw error;
    }

    const message = errorMessage(error);
    const code = error instanceof LipSyncProviderError ? error.code : 'EXPORT_FAILED';
    try {
      await deps.jobs.fail(effective.jobId, code, message);
      if (effective.modern && effective.exportId && deps.exports) {
        if (!(standardPublished && effective.visualMode === 'lip_sync')) {
          await deps.exports.fail(effective.projectId, effective.exportId, effective.userId, code, message);
        }
      } else {
        await deps.projects.setStatus(effective.projectId, effective.userId, 'needs_review');
      }
    } catch {
      // Preserve the original export failure if durable failure recording also fails.
    }
    throw error;
  }
}
