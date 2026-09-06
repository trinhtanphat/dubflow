import type { AudioStemRepository } from '../db/audio-stems';
import type { ProjectStatus } from '../db/projects';
import type { DubbingJob, JobStore } from '../db/jobs';
import type { UsageStore } from '../db/usage';
import { parseDubbedAudioMode, type DubbedAudioMode } from '../domain/audio-mode';
import type { ExportOutput, TargetLanguage } from '../domain/language';
import { isTargetLanguage } from '../domain/language';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import type { RenderExportOptions } from '../services/media/types';
import {
  DialogueSeparationError,
  type DialogueSeparationCapabilities,
  type DialogueSeparationProvider,
} from '../services/separation/types';
import { serializeSrt } from '../services/subtitles/srt';
import type { VoiceGenerateInput } from '../services/voice/types';
import { JobCancelledError, assertJobActive, isJobCancelledError } from './jobCancellation';

export type ExportWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  exportId: string;
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  audioMode?: DubbedAudioMode;
  requestId?: string;
};

type LegacyExportWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  requestId?: string;
};

type RunExportWorkflowParams = ExportWorkflowParams | LegacyExportWorkflowParams;

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
  sourceGeneration?: number | null;
};

type ExportSegment = {
  id: string;
  speakerId?: string | null;
  startMs: number;
  endMs: number;
  translatedText: string;
  voiceStatus: string;
  dubbedObjectKey?: string | null;
  version?: number;
};

type ExportVariant = {
  segmentId: string;
  targetLanguage: TargetLanguage;
  translatedText: string;
  translationStatus: string;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
};

type ExportWorkItem = {
  id: string;
  speakerId?: string | null;
  startMs: number;
  endMs: number;
  translatedText: string;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
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
type ExportStems = Pick<AudioStemRepository, 'latestCompleted' | 'begin' | 'complete' | 'fail'>;

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
  translations?: {
    list(projectId: string, userId: string, targetLanguage: TargetLanguage): Promise<ExportVariant[]>;
    setVoiceResult(
      projectId: string,
      segmentId: string,
      userId: string,
      targetLanguage: TargetLanguage,
      objectKey: string,
    ): Promise<void>;
  };
  exports?: {
    complete(
      projectId: string,
      exportId: string,
      userId: string,
      keys: { exportObjectKey?: string | null; subtitleObjectKey?: string | null },
    ): Promise<void>;
    fail(projectId: string, exportId: string, userId: string, code: string, message: string): Promise<void>;
  };
  speakers?: {
    list(projectId: string, userId: string): Promise<ExportSpeaker[]>;
  };
  stems?: ExportStems;
  separation?: DialogueSeparationProvider;
  bucket: {
    put?(key: string, value: ArrayBuffer): Promise<unknown>;
  };
  voice: {
    generate(input: VoiceGenerateInput): Promise<unknown>;
  };
  media: {
    probe(objectKey: string): Promise<{ durationMs: number }>;
    renderExport(
      projectId: string,
      sourceObjectKey: string,
      clips: ExportClip[],
      options?: RenderExportOptions,
    ): Promise<{ exportObjectKey: string }>;
  };
  usage: ExportUsage;
  telemetry: TelemetrySink;
};

type NormalizedExportParams = {
  projectId: string;
  userId: string;
  jobId: string;
  requestId?: string;
  modern: boolean;
  exportId: string | null;
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  audioMode: DubbedAudioMode;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown export failure.';
}

function normalizeParams(params: RunExportWorkflowParams): NormalizedExportParams {
  const candidate = params as Partial<ExportWorkflowParams> & LegacyExportWorkflowParams;
  const modernFieldPresent = candidate.exportId !== undefined
    || candidate.targetLanguage !== undefined
    || candidate.output !== undefined
    || candidate.audioMode !== undefined;
  if (!modernFieldPresent) {
    return {
      ...params,
      modern: false,
      exportId: null,
      targetLanguage: 'vi',
      output: 'dubbed',
      audioMode: 'dubbed_only',
    };
  }
  const audioMode = parseDubbedAudioMode(candidate.audioMode);
  if (
    typeof candidate.exportId !== 'string' || !candidate.exportId.trim()
    || !isTargetLanguage(candidate.targetLanguage)
    || (candidate.output !== 'dubbed' && candidate.output !== 'subtitles')
    || !audioMode
    || (candidate.output === 'subtitles' && audioMode !== 'dubbed_only')
  ) {
    throw new Error('Export workflow parameters are invalid.');
  }
  return {
    projectId: params.projectId,
    userId: params.userId,
    jobId: params.jobId,
    requestId: params.requestId,
    modern: true,
    exportId: candidate.exportId,
    targetLanguage: candidate.targetLanguage,
    output: candidate.output,
    audioMode,
  };
}

function legacyAudioObjectKey(projectId: string, segmentId: string): string {
  return `projects/${projectId}/dubbed/${segmentId}.mp3`;
}

function targetAudioObjectKey(projectId: string, targetLanguage: TargetLanguage, segmentId: string, version: number): string {
  return `projects/${projectId}/voices/${targetLanguage}/${segmentId}/${version}.mp3`;
}

function operationKey(jobId: string, retryCount: number, stage: string, item: string, provider: string): string {
  return `job:${jobId}:retry:${retryCount}:${stage}:${item}:${provider}`;
}

function separationOperationKey(projectId: string, sourceGeneration: number, provider: string): string {
  return `project:${projectId}:source:${sourceGeneration}:dialogue-separation:${provider}`;
}

function separationCapabilityError(capabilities: DialogueSeparationCapabilities): DialogueSeparationError | null {
  if (capabilities.qualification === 'unqualified') {
    return new DialogueSeparationError(
      'DIALOGUE_SEPARATION_UNQUALIFIED',
      'Dialogue separation capability has not been qualified.',
    );
  }
  if (
    capabilities.qualification !== 'qualified'
    || capabilities.configured !== true
    || capabilities.backgroundStem !== true
    || typeof capabilities.provider !== 'string'
    || capabilities.provider.trim() === ''
  ) {
    return new DialogueSeparationError('DIALOGUE_SEPARATION_UNAVAILABLE', 'Dialogue separation is unavailable.');
  }
  return null;
}

function speakerVoiceId(segment: ExportWorkItem, speakers: Map<string, ExportSpeaker>): string | undefined {
  const speakerId = segment.speakerId?.trim();
  if (!speakerId) return undefined;
  const speaker = speakers.get(speakerId);
  if (!speaker?.voiceId?.trim()) return undefined;
  if (speaker.voiceProvider && speaker.voiceProvider !== 'elevenlabs') {
    throw new Error(`Speaker ${speakerId} uses unsupported voice provider ${speaker.voiceProvider}.`);
  }
  return speaker.voiceId.trim();
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function probeTtsSeconds(deps: ExportPipelineDeps, objectKey: string): Promise<number> {
  const metadata = await deps.media.probe(objectKey);
  const seconds = metadata.durationMs / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Generated voice duration is invalid.');
  }
  return seconds;
}

function targetWorkItems(sourceSegments: ExportSegment[], variants: ExportVariant[], targetLanguage: TargetLanguage): ExportWorkItem[] {
  if (variants.length !== sourceSegments.length) throw new Error(`Translation variants for ${targetLanguage} are incomplete.`);
  const bySegment = new Map<string, ExportVariant>();
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

function legacyWorkItems(segments: ExportSegment[]): ExportWorkItem[] {
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

async function resolveSeparatedBackground(
  params: NormalizedExportParams,
  project: ExportProject,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
  ensureActive: () => Promise<void>,
): Promise<string | undefined> {
  if (params.audioMode !== 'separated_background') return undefined;
  if (!deps.separation || !deps.stems) {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_UNAVAILABLE', 'Dialogue separation is unavailable.');
  }
  const capabilities = await step.do('load dialogue separation capabilities', () => deps.separation!.capabilities());
  const capabilityError = separationCapabilityError(capabilities);
  if (capabilityError) throw capabilityError;

  const provider = capabilities.provider!.trim();
  const sourceGeneration = Number(project.sourceGeneration);
  if (!Number.isInteger(sourceGeneration) || sourceGeneration < 1) {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', 'Project source generation is invalid.');
  }
  const durationMs = Number(project.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', 'Project duration is invalid for separation.');
  }
  const expectedKey = `projects/${params.projectId}/stems/${sourceGeneration}/${provider}/background.wav`;
  const completedStem = await step.do('load reusable background stem', () =>
    deps.stems!.latestCompleted(params.projectId, params.userId, sourceGeneration, 'background', provider),
  );
  if (completedStem) {
    if (completedStem.objectKey !== expectedKey) {
      throw new DialogueSeparationError(
        'DIALOGUE_SEPARATION_ARTIFACT_INVALID',
        'Completed dialogue separation stem has an invalid object key.',
      );
    }
    return completedStem.objectKey;
  }

  const usageKey = separationOperationKey(params.projectId, sourceGeneration, provider);
  const completedUsage = await step.do('load completed dialogue separation usage', () =>
    deps.usage.getByOperation(usageKey, 'completed'),
  );
  if (completedUsage) {
    throw new DialogueSeparationError(
      'DIALOGUE_SEPARATION_ARTIFACT_INVALID',
      'Completed dialogue separation accounting has no durable reusable background stem.',
    );
  }

  await step.do('check cancellation before dialogue separation', ensureActive);
  const pending = await step.do('claim dialogue separation background stem', () =>
    deps.stems!.begin(params.projectId, params.userId, sourceGeneration, 'background', provider, null),
  );
  if (pending.status === 'completed') {
    if (pending.objectKey !== expectedKey) {
      throw new DialogueSeparationError(
        'DIALOGUE_SEPARATION_ARTIFACT_INVALID',
        'Claimed dialogue separation stem has an invalid object key.',
      );
    }
    return pending.objectKey;
  }

  const units = durationMs / 1000;
  await step.do('record dialogue separation started usage', () => deps.usage.record({
    userId: params.userId,
    projectId: params.projectId,
    jobId: params.jobId,
    kind: 'dialogue_separation_second',
    units,
    provider,
    phase: 'started',
    operationKey: usageKey,
  }));
  await step.do('check cancellation before dialogue separation provider', ensureActive);

  let result;
  try {
    result = await step.do('separate source dialogue and background', () => deps.separation!.separate({
      projectId: params.projectId,
      sourceObjectKey: project.sourceObjectKey!,
      sourceGeneration,
      durationMs,
    }));
  } catch (error) {
    const message = errorMessage(error);
    try {
      await deps.stems.fail(params.projectId, pending.id, params.userId, 'DIALOGUE_SEPARATION_FAILED', message);
    } catch {
      // Preserve the provider failure if durable stem failure recording also fails.
    }
    if (error instanceof DialogueSeparationError) throw error;
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_FAILED', message);
  }

  if (result.provider !== provider || result.backgroundObjectKey !== expectedKey) {
    const message = 'Dialogue separation provider returned an invalid background artifact.';
    try {
      await deps.stems.fail(params.projectId, pending.id, params.userId, 'DIALOGUE_SEPARATION_ARTIFACT_INVALID', message);
    } catch {
      // Preserve artifact validation failure.
    }
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', message);
  }

  await step.do('persist completed dialogue separation stem', () =>
    deps.stems!.complete(
      params.projectId,
      pending.id,
      params.userId,
      result.backgroundObjectKey,
      result.providerVersion ?? null,
    ),
  );
  await step.do('record dialogue separation completed usage', () => deps.usage.record({
    userId: params.userId,
    projectId: params.projectId,
    jobId: params.jobId,
    kind: 'dialogue_separation_second',
    units,
    provider,
    phase: 'completed',
    operationKey: usageKey,
  }));
  return result.backgroundObjectKey;
}

export async function runExportPipeline(
  inputParams: RunExportWorkflowParams,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): Promise<{ status: 'completed'; exportObjectKey: string } | { status: 'completed'; subtitleObjectKey: string }> {
  let params: NormalizedExportParams | null = null;
  try {
    params = normalizeParams(inputParams);
    const ensureActive = () => assertJobActive(deps.jobs, params!.projectId, params!.jobId, params!.userId);
    const project = await step.do('authorize export project', async () =>
      deps.projects.getByIdForUser(params!.projectId, params!.userId),
    );
    if (!project) throw new Error('Project not found.');
    if (params.output === 'dubbed' && !project.sourceObjectKey) throw new Error('Project source media is missing.');

    const job = await step.do('load export retry generation', async () =>
      deps.jobs.getForProject(params!.projectId, params!.jobId, params!.userId),
    );
    if (!job) throw new Error('Job not found.');
    if (job.status === 'cancelled') throw new JobCancelledError();
    if (!Number.isInteger(job.retryCount) || job.retryCount < 0) throw new Error('Job retry generation is invalid.');
    const retryCount = job.retryCount;

    const sourceSegments = await step.do('load canonical export segments', async () =>
      deps.segments.list(params!.projectId, params!.userId),
    );
    if (sourceSegments.length === 0) throw new Error('No translated segments are available for export.');

    let segments: ExportWorkItem[];
    if (params.modern) {
      if (!deps.translations || !deps.exports || !params.exportId) throw new Error('Target export persistence is unavailable.');
      const variants = await step.do(`load ${params.targetLanguage} export variants`, async () =>
        deps.translations!.list(params!.projectId, params!.userId, params!.targetLanguage),
      );
      segments = targetWorkItems(sourceSegments, variants, params.targetLanguage);
    } else {
      segments = legacyWorkItems(sourceSegments);
      const emptyTranslation = segments.find((segment) => !segment.translatedText.trim());
      if (emptyTranslation) throw new Error(`Segment ${emptyTranslation.id} has no translated text.`);
    }

    await step.do('check cancellation before export processing', ensureActive);

    if (params.output === 'subtitles') {
      if (!params.modern || !params.exportId || !deps.exports) throw new Error('Subtitle export requires target export persistence.');
      if (!deps.bucket.put) throw new Error('R2 put is unavailable for subtitle export.');
      const subtitleObjectKey = `projects/${params.projectId}/subtitles/${params.targetLanguage}/${params.exportId}.srt`;
      const text = serializeSrt(segments.map((segment, index) => ({
        index: index + 1,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.translatedText,
      })));
      await step.do('publish target subtitles', async () => {
        await deps.bucket.put!(subtitleObjectKey, arrayBuffer(new TextEncoder().encode(text)));
        await deps.exports!.complete(params!.projectId, params!.exportId!, params!.userId, { subtitleObjectKey });
        await deps.jobs.complete(params!.jobId);
      });
      return { status: 'completed', subtitleObjectKey };
    }

    const backgroundObjectKey = await resolveSeparatedBackground(params, project, deps, step, ensureActive);

    const speakerRows = deps.speakers
      ? await step.do('load export speaker voices', async () => deps.speakers!.list(params!.projectId, params!.userId))
      : [];
    const speakers = new Map(speakerRows.map((speaker) => [speaker.id, speaker]));

    await step.do('mark export processing', async () => {
      if (!params!.modern) await deps.projects.setStatus(params!.projectId, params!.userId, 'processing');
      await deps.jobs.setProgress(params!.jobId, 0.05, 'generating_voice');
    });

    const clips: ExportClip[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      await step.do(`check cancellation before voice ${segment.id}`, ensureActive);
      const expectedObjectKey = params.modern
        ? targetAudioObjectKey(params.projectId, params.targetLanguage, segment.id, segment.version)
        : legacyAudioObjectKey(params.projectId, segment.id);
      let objectKey = segment.voiceStatus === 'completed' && segment.dubbedObjectKey
        && (!params.modern || segment.dubbedObjectKey === expectedObjectKey)
        ? segment.dubbedObjectKey
        : null;

      const ttsProvider = 'elevenlabs';
      const ttsItem = params.modern ? `${params.targetLanguage}:${segment.id}` : segment.id;
      const ttsKey = operationKey(params.jobId, retryCount, 'tts', ttsItem, ttsProvider);
      const started = await step.do(`load TTS started usage ${segment.id}`, async () => deps.usage.getByOperation(ttsKey, 'started'));
      const completed = await step.do(`load TTS completed usage ${segment.id}`, async () => deps.usage.getByOperation(ttsKey, 'completed'));

      if (objectKey) {
        if (started && !completed) {
          await step.do(`recover TTS usage ${segment.id}`, async () => {
            const units = await probeTtsSeconds(deps, objectKey!);
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
        objectKey = expectedObjectKey;
        await step.do(`generate voice ${segment.id}`, async () => {
          if (!deps.bucket.put) throw new Error('R2 put is unavailable for voice generation.');
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
          const input: VoiceGenerateInput = voice
            ? { text, language: params!.targetLanguage, voice }
            : { text, language: params!.targetLanguage };
          const generated = await withProviderTelemetry(deps.telemetry, {
            requestId: params!.requestId,
            actorId: params!.userId,
            projectId: params!.projectId,
            jobId: params!.jobId,
            operation: 'voice',
            provider: ttsProvider,
            errorCode: 'VOICE_PROVIDER_FAILED',
          }, () => deps.voice.generate(input));
          if (!(generated instanceof Response)) throw new Error('Voice provider returned an unsupported response.');
          if (!generated.ok) throw new Error(`Voice provider failed (${generated.status}).`);
          const audio = await generated.arrayBuffer();
          if (audio.byteLength === 0) throw new Error('Voice provider returned empty audio.');
          await deps.bucket.put(objectKey!, audio);
          if (params!.modern) {
            await deps.translations!.setVoiceResult(params!.projectId, segment.id, params!.userId, params!.targetLanguage, objectKey!);
          } else {
            await deps.segments.setVoiceResult(params!.projectId, segment.id, params!.userId, objectKey!);
          }
          const units = await probeTtsSeconds(deps, objectKey!);
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

      clips.push({ segmentId: segment.id, startMs: segment.startMs, endMs: segment.endMs, objectKey });
      const progress = 0.1 + ((index + 1) / segments.length) * 0.55;
      await step.do(`persist voice progress ${segment.id}`, async () =>
        deps.jobs.setProgress(params!.jobId, progress, 'generating_voice'),
      );
    }

    await step.do('check cancellation before export render', ensureActive);
    await step.do('mark render stage', async () => deps.jobs.setProgress(params!.jobId, 0.72, 'rendering_export'));

    const renderSeconds = Number(project.durationMs) / 1000;
    if (!Number.isFinite(renderSeconds) || renderSeconds <= 0) throw new Error('Project duration is missing or invalid for render metering.');
    const renderProvider = 'ffmpeg-container';
    const renderItem = params.modern ? `${params.targetLanguage}:final` : 'final';
    const renderKey = operationKey(params.jobId, retryCount, 'render', renderItem, renderProvider);
    const rendered = await step.do('render final dubbed media', async () => {
      const common = {
        userId: params!.userId,
        projectId: params!.projectId,
        jobId: params!.jobId,
        kind: 'render_second' as const,
        units: renderSeconds,
        provider: renderProvider,
        operationKey: renderKey,
      };
      await deps.usage.record({ ...common, phase: 'started' });
      const options: RenderExportOptions | undefined = params!.modern
        ? {
          targetLanguage: params!.targetLanguage,
          exportId: params!.exportId!,
          audioMode: params!.audioMode,
          ...(backgroundObjectKey ? { backgroundObjectKey } : {}),
        }
        : undefined;
      const result = await withProviderTelemetry(deps.telemetry, {
        requestId: params!.requestId,
        actorId: params!.userId,
        projectId: params!.projectId,
        jobId: params!.jobId,
        operation: 'render',
        provider: renderProvider,
        errorCode: 'MEDIA_RENDER_FAILED',
      }, () => options
        ? deps.media.renderExport(params!.projectId, project.sourceObjectKey!, clips, options)
        : deps.media.renderExport(params!.projectId, project.sourceObjectKey!, clips));
      const expected = params!.modern
        ? `projects/${params!.projectId}/exports/${params!.targetLanguage}/${params!.exportId}.mp4`
        : null;
      if (
        typeof result.exportObjectKey !== 'string'
        || (expected ? result.exportObjectKey !== expected : !result.exportObjectKey.startsWith(`projects/${params!.projectId}/export/`))
      ) {
        throw new Error('Media processor returned an invalid export object key.');
      }
      await deps.usage.record({ ...common, phase: 'completed' });
      return result;
    });

    await step.do('check cancellation before export publish', ensureActive);
    await step.do('publish final export', async () => {
      if (params!.modern) {
        await deps.exports!.complete(params!.projectId, params!.exportId!, params!.userId, { exportObjectKey: rendered.exportObjectKey });
        if (params!.targetLanguage === 'vi') {
          await deps.projects.setExportObject(params!.projectId, params!.userId, rendered.exportObjectKey);
        }
      } else {
        await deps.projects.setExportObject(params!.projectId, params!.userId, rendered.exportObjectKey);
        await deps.projects.setStatus(params!.projectId, params!.userId, 'completed');
      }
      await deps.jobs.complete(params!.jobId);
    });

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
    };
    if (isJobCancelledError(error)) {
      if (!effective.modern) {
        try {
          await deps.projects.setStatus(effective.projectId, effective.userId, 'cancelled');
        } catch {
          // Preserve the cancellation error if the project status write also fails.
        }
      }
      throw error;
    }

    const message = errorMessage(error);
    const code = error instanceof DialogueSeparationError ? error.code : 'EXPORT_FAILED';
    try {
      await deps.jobs.fail(effective.jobId, code, message);
      if (effective.modern && effective.exportId && deps.exports) {
        await deps.exports.fail(effective.projectId, effective.exportId, effective.userId, code, message);
      } else {
        await deps.projects.setStatus(effective.projectId, effective.userId, 'needs_review');
      }
    } catch {
      // Preserve the original export failure if durable failure recording also fails.
    }
    throw error;
  }
}
