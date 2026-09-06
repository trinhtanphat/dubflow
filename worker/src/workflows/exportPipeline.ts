import type { ProjectStatus } from '../db/projects';
import type { DubbingJob, JobStore } from '../db/jobs';
import type { UsageStore } from '../db/usage';
import type { ExportOutput, TargetLanguage } from '../domain/language';
import { isTargetLanguage } from '../domain/language';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import type { VoiceGenerateInput } from '../services/voice/types';
import type { RenderExportOptions } from '../services/media/types';
import type { SeparationMode, StemSeparationProvider } from '../services/separation/types';
import { serializeSrt } from '../services/subtitles/srt';
import { JobCancelledError, assertJobActive, isJobCancelledError } from './jobCancellation';

export type ExportWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  exportId: string;
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  separationMode?: SeparationMode;
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
  bucket: {
    put?(key: string, value: ArrayBuffer): Promise<unknown>;
    head?(key: string): Promise<unknown | null>;
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
  separation?: StemSeparationProvider;
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
  separationMode: SeparationMode;
};

type CanonicalStemPair = {
  sourceRevision: string;
  dialogueObjectKey: string;
  backgroundObjectKey: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown export failure.';
}

function normalizeParams(params: RunExportWorkflowParams): NormalizedExportParams {
  const candidate = params as Partial<ExportWorkflowParams> & LegacyExportWorkflowParams;
  const modernFieldPresent = candidate.exportId !== undefined || candidate.targetLanguage !== undefined || candidate.output !== undefined;
  if (!modernFieldPresent) {
    return {
      ...params,
      modern: false,
      exportId: null,
      targetLanguage: 'vi',
      output: 'dubbed',
      separationMode: 'source_mix',
    };
  }
  const separationMode = candidate.separationMode ?? 'source_mix';
  if (
    typeof candidate.exportId !== 'string' || !candidate.exportId.trim() ||
    !isTargetLanguage(candidate.targetLanguage) ||
    (candidate.output !== 'dubbed' && candidate.output !== 'subtitles') ||
    (separationMode !== 'source_mix' && separationMode !== 'preserve_background') ||
    (candidate.output === 'subtitles' && separationMode !== 'source_mix')
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
    separationMode,
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

async function probePositiveSeconds(deps: ExportPipelineDeps, objectKey: string, label: string): Promise<number> {
  const metadata = await deps.media.probe(objectKey);
  const seconds = metadata.durationMs / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${label} duration is invalid.`);
  }
  return seconds;
}

async function probeTtsSeconds(deps: ExportPipelineDeps, objectKey: string): Promise<number> {
  return probePositiveSeconds(deps, objectKey, 'Generated voice');
}

function canonicalStemPair(projectId: string, sourceObjectKey: string): CanonicalStemPair {
  const prefix = `projects/${projectId}/source/`;
  if (!sourceObjectKey.startsWith(prefix)) {
    throw new Error('Project source media key is not a canonical immutable source object.');
  }
  const filename = sourceObjectKey.slice(prefix.length);
  if (!filename || filename.includes('/')) {
    throw new Error('Project source media key is not a canonical immutable source object.');
  }
  const extensionAt = filename.lastIndexOf('.');
  if (extensionAt <= 0 || extensionAt === filename.length - 1) {
    throw new Error('Project source media key has no immutable source revision.');
  }
  const sourceRevision = filename.slice(0, extensionAt);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sourceRevision)) {
    throw new Error('Project source media revision is invalid.');
  }
  const stemPrefix = `projects/${projectId}/stems/${sourceRevision}`;
  return {
    sourceRevision,
    dialogueObjectKey: `${stemPrefix}/dialogue.wav`,
    backgroundObjectKey: `${stemPrefix}/background.wav`,
  };
}

async function hasCanonicalStemPair(deps: ExportPipelineDeps, pair: CanonicalStemPair): Promise<boolean> {
  if (!deps.bucket.head) throw new Error('R2 head is unavailable for stem separation.');
  const [dialogue, background] = await Promise.all([
    deps.bucket.head(pair.dialogueObjectKey),
    deps.bucket.head(pair.backgroundObjectKey),
  ]);
  return Boolean(dialogue && background);
}

async function prepareBackgroundStem(
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
  params: NormalizedExportParams,
  sourceObjectKey: string,
  retryCount: number,
  ensureActive: () => Promise<void>,
): Promise<string | undefined> {
  if (params.separationMode === 'source_mix') return undefined;
  const separation = deps.separation;
  if (!separation?.available) {
    throw new Error('Dialogue/background stem separation is unavailable.');
  }

  const pair = canonicalStemPair(params.projectId, sourceObjectKey);
  const separationKey = operationKey(
    params.jobId,
    retryCount,
    'stem-separation',
    pair.sourceRevision,
    separation.id,
  );
  const started = await step.do('load stem separation started usage', async () =>
    deps.usage.getByOperation(separationKey, 'started'),
  );
  const completed = await step.do('load stem separation completed usage', async () =>
    deps.usage.getByOperation(separationKey, 'completed'),
  );
  const durable = await step.do('check canonical stem pair', async () => hasCanonicalStemPair(deps, pair));

  if (completed && !durable) {
    throw new Error('Completed stem separation usage without a durable stem pair.');
  }

  if (durable) {
    if (started && !completed) {
      await step.do('recover stem separation usage', async () => {
        const units = await probePositiveSeconds(deps, sourceObjectKey, 'Source media');
        await deps.usage.record({
          userId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          kind: 'stem_separation_audio_second',
          units,
          provider: separation.id,
          phase: 'completed',
          operationKey: separationKey,
        });
      });
    }
    return pair.backgroundObjectKey;
  }

  await step.do('check cancellation before stem separation', ensureActive);
  if (!started) {
    await step.do('record stem separation start', async () => {
      await deps.usage.record({
        userId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        kind: 'stem_separation_audio_second',
        units: 0,
        provider: separation.id,
        phase: 'started',
        operationKey: separationKey,
      });
    });
  }

  await step.do('separate dialogue and background stems', async () => {
    const result = await withProviderTelemetry(deps.telemetry, {
      requestId: params.requestId,
      actorId: params.userId,
      projectId: params.projectId,
      jobId: params.jobId,
      operation: 'stem_separation',
      provider: separation.id,
      errorCode: 'STEM_SEPARATION_FAILED',
    }, () => separation.separate({
      projectId: params.projectId,
      sourceObjectKey,
      sourceRevision: pair.sourceRevision,
    }));
    if (
      result.dialogueObjectKey !== pair.dialogueObjectKey ||
      result.backgroundObjectKey !== pair.backgroundObjectKey
    ) {
      throw new Error('Stem separation returned a non-canonical stem pair.');
    }
  });

  const persisted = await step.do('verify canonical stem pair', async () => hasCanonicalStemPair(deps, pair));
  if (!persisted) throw new Error('Stem separation completed without a durable stem pair.');

  await step.do('complete stem separation usage', async () => {
    const units = await probePositiveSeconds(deps, sourceObjectKey, 'Source media');
    await deps.usage.record({
      userId: params.userId,
      projectId: params.projectId,
      jobId: params.jobId,
      kind: 'stem_separation_audio_second',
      units,
      provider: separation.id,
      phase: 'completed',
      operationKey: separationKey,
    });
  });
  return pair.backgroundObjectKey;
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

    const backgroundObjectKey = await prepareBackgroundStem(
      deps,
      step,
      params,
      project.sourceObjectKey!,
      retryCount,
      ensureActive,
    );

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
        typeof result.exportObjectKey !== 'string' ||
        (expected ? result.exportObjectKey !== expected : !result.exportObjectKey.startsWith(`projects/${params!.projectId}/export/`))
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
      separationMode: 'source_mix' as const,
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
    try {
      await deps.jobs.fail(effective.jobId, 'EXPORT_FAILED', message);
      if (effective.modern && effective.exportId && deps.exports) {
        await deps.exports.fail(effective.projectId, effective.exportId, effective.userId, 'EXPORT_FAILED', message);
      } else {
        await deps.projects.setStatus(effective.projectId, effective.userId, 'needs_review');
      }
    } catch {
      // Preserve the original export failure if durable failure recording also fails.
    }
    throw error;
  }
}
