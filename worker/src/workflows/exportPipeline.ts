import type { ProjectStatus } from '../db/projects';
import type { DubbingJob, JobStore } from '../db/jobs';
import type { MultilangStore, TargetTranslation } from '../db/multilang';
import type { TranslationContextStore } from '../db/translation-context';
import type { UsageStore } from '../db/usage';
import type { TargetLanguage } from '../domain/target-language';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import type { ExportRenderOptions } from '../services/media/types';
import { isTranslationContextActive } from '../services/translation/context';
import type { TranslationRouter } from '../services/translation/router';
import type { VoiceGenerateInput } from '../services/voice/types';
import { JobCancelledError, assertJobActive, isJobCancelledError } from './jobCancellation';

export type ExportWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  requestId?: string;
  exportId?: string;
  batchId?: string;
  targetLanguage?: TargetLanguage;
};

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
  sourceLanguage?: 'auto' | 'zh' | 'en' | 'ja' | 'ko';
  durationMs?: number | null;
};

type ExportSegment = {
  id: string;
  speakerId?: string | null;
  startMs: number;
  endMs: number;
  sourceText?: string;
  translatedText: string;
  translationEngine?: string;
  version?: number;
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
type ExportTranslationContext = Pick<TranslationContextStore, 'getContext'>;
type ExportTranslationRouter = Pick<TranslationRouter, 'translate'>;

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
    renderExport(projectId: string, sourceObjectKey: string, clips: ExportClip[], options?: ExportRenderOptions): Promise<{ exportObjectKey: string }>;
  };
  usage: ExportUsage;
  telemetry: TelemetrySink;
  multilang?: MultilangStore;
  translationContext?: ExportTranslationContext;
  translationRouter?: ExportTranslationRouter;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown export failure.';
}

function legacyAudioObjectKey(projectId: string, segmentId: string): string {
  return `projects/${projectId}/dubbed/${segmentId}.mp3`;
}

function targetAudioObjectKey(projectId: string, targetLanguage: TargetLanguage, segmentId: string, version: number): string {
  return `projects/${projectId}/dubbed/${targetLanguage}/${segmentId}/${version}.mp3`;
}

function operationKey(jobId: string, retryCount: number, stage: string, item: string, provider: string): string {
  return `job:${jobId}:retry:${retryCount}:${stage}:${item}:${provider}`;
}

function targetOperationKey(jobId: string, retryCount: number, targetLanguage: TargetLanguage, stage: string, item: string, provider: string): string {
  return `job:${jobId}:retry:${retryCount}:target:${targetLanguage}:${stage}:${item}:${provider}`;
}

function sourceCharacters(texts: string[]): number {
  return Array.from(texts.join('')).length;
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

async function probeTtsSeconds(deps: ExportPipelineDeps, objectKey: string): Promise<number> {
  const metadata = await deps.media.probe(objectKey);
  const seconds = metadata.durationMs / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Generated voice duration is invalid.');
  return seconds;
}

function targetVersion(segment: ExportSegment): number {
  if (!Number.isInteger(segment.version) || Number(segment.version) < 1) throw new Error(`Segment ${segment.id} has an invalid version.`);
  return Number(segment.version);
}

function sourceText(segment: ExportSegment): string {
  const text = segment.sourceText?.trim() ?? '';
  if (!text) throw new Error(`Segment ${segment.id} has no source text.`);
  return text;
}

async function reconcileBatchProjectStatus(
  params: Required<Pick<ExportWorkflowParams, 'projectId' | 'userId' | 'batchId'>>,
  deps: ExportPipelineDeps,
): Promise<void> {
  if (!deps.multilang) return;
  const siblings = await deps.multilang.listBatchExports(params.projectId, params.userId, params.batchId);
  if (siblings.length === 0) return;
  if (siblings.some((row) => row.status === 'queued' || row.status === 'running')) {
    await deps.projects.setStatus(params.projectId, params.userId, 'processing');
    return;
  }
  if (siblings.some((row) => row.status === 'failed' || row.status === 'cancelled')) {
    await deps.projects.setStatus(params.projectId, params.userId, 'needs_review');
    return;
  }
  await deps.projects.setStatus(params.projectId, params.userId, 'completed');
}

async function loadOrTranslateTarget(
  params: Required<Pick<ExportWorkflowParams, 'projectId' | 'userId' | 'jobId' | 'targetLanguage'>> & Pick<ExportWorkflowParams, 'requestId'>,
  project: ExportProject,
  segments: ExportSegment[],
  retryCount: number,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): Promise<Map<string, TargetTranslation>> {
  if (!deps.multilang || !deps.translationContext || !deps.translationRouter) throw new Error('Multi-language translation dependencies are unavailable.');
  if (!project.sourceLanguage || project.sourceLanguage === 'auto') throw new Error('Resolve source language before multi-language export.');

  const current = new Map<string, TargetTranslation>();
  const missing: ExportSegment[] = [];
  for (const segment of segments) {
    const version = targetVersion(segment);
    const existing = await step.do(`load ${params.targetLanguage} translation ${segment.id}`, () =>
      deps.multilang!.getTranslation(params.projectId, segment.id, params.userId, params.targetLanguage),
    );
    if (existing?.translationStatus === 'completed' && existing.sourceSegmentVersion === version && existing.translatedText.trim()) {
      current.set(segment.id, existing);
      continue;
    }
    if (params.targetLanguage === 'vi' && segment.translatedText.trim()) {
      const mirrored: TargetTranslation = {
        segmentId: segment.id,
        projectId: params.projectId,
        targetLanguage: 'vi',
        translatedText: segment.translatedText,
        translationEngine: segment.translationEngine ?? 'workers-ai',
        translationStatus: 'completed',
        contextRevision: null,
        sourceSegmentVersion: version,
        version: (existing?.version ?? 0) + 1,
      };
      await step.do(`mirror Vietnamese translation ${segment.id}`, () => deps.multilang!.upsertTranslation({ ...mirrored, userId: params.userId }));
      current.set(segment.id, mirrored);
      continue;
    }
    missing.push(segment);
  }
  if (missing.length === 0) return current;

  const context = await step.do(`load ${params.targetLanguage} translation context snapshot`, () =>
    deps.translationContext!.getContext(params.projectId, params.userId),
  );
  if (!context) throw new Error('Project translation context not found.');
  const expectedProvider = isTranslationContextActive(context) ? 'workers-ai-contextual' : 'workers-ai';
  const batchSize = 25;
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    const batch = missing.slice(offset, offset + batchSize);
    const items = batch.map((segment) => ({ id: segment.id, text: sourceText(segment) }));
    const usageKey = targetOperationKey(params.jobId, retryCount, params.targetLanguage, 'translation', `batch-${offset}`, expectedProvider);
    const units = sourceCharacters(items.map((item) => item.text));
    const common = {
      userId: params.userId,
      projectId: params.projectId,
      jobId: params.jobId,
      kind: 'translation_character' as const,
      units,
      provider: expectedProvider,
      operationKey: usageKey,
    };
    await step.do(`start ${params.targetLanguage} translation usage ${offset}`, () => deps.usage.record({ ...common, phase: 'started' }));
    const routed = await step.do(`translate ${params.targetLanguage} segments ${offset + 1}-${offset + batch.length}`, () =>
      withProviderTelemetry(deps.telemetry, {
        requestId: params.requestId,
        actorId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        operation: 'translate',
        provider: expectedProvider,
        errorCode: 'TRANSLATION_FAILED',
      }, () => deps.translationRouter!.translate(undefined, items, project.sourceLanguage!, params.targetLanguage, context)),
    );
    if (routed.mode === 'compare') throw new Error('Compare mode cannot be persisted by export workflow.');
    const actualProvider = routed.mode === 'contextual' ? 'workers-ai-contextual' : routed.mode === 'google' ? 'google' : 'workers-ai';
    if (actualProvider !== expectedProvider) throw new Error(`Translation provider mismatch: expected ${expectedProvider}, received ${actualProvider}.`);
    const byId = new Map(routed.primary.map((row) => [row.id, row]));
    if (byId.size !== items.length) throw new Error('Translation results did not preserve segment ids.');
    for (const segment of batch) {
      const translated = byId.get(segment.id);
      if (!translated?.text.trim()) throw new Error(`Missing translation result for ${segment.id}.`);
      const previous = await deps.multilang.getTranslation(params.projectId, segment.id, params.userId, params.targetLanguage);
      const row: TargetTranslation = {
        segmentId: segment.id,
        projectId: params.projectId,
        targetLanguage: params.targetLanguage,
        translatedText: translated.text,
        translationEngine: routed.mode === 'google' ? 'google' : 'workers-ai',
        translationStatus: 'completed',
        contextRevision: routed.contextRevision,
        sourceSegmentVersion: targetVersion(segment),
        version: (previous?.version ?? 0) + 1,
      };
      await deps.multilang.upsertTranslation({ ...row, userId: params.userId });
      current.set(segment.id, row);
    }
    await step.do(`complete ${params.targetLanguage} translation usage ${offset}`, () => deps.usage.record({ ...common, phase: 'completed' }));
  }
  return current;
}

async function runTargetExportPipeline(
  params: ExportWorkflowParams,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): Promise<{ status: 'completed'; exportObjectKey: string }> {
  if (!params.exportId || !params.batchId || !params.targetLanguage || !deps.multilang) {
    throw new Error('Target export identity is incomplete.');
  }
  const targetLanguage = params.targetLanguage;
  const targetParams = { projectId: params.projectId, userId: params.userId, jobId: params.jobId, targetLanguage, requestId: params.requestId };
  const ensureActive = () => assertJobActive(deps.jobs, params.projectId, params.jobId, params.userId);
  try {
    const project = await step.do('authorize target export project', () => deps.projects.getByIdForUser(params.projectId, params.userId));
    if (!project?.sourceObjectKey) throw new Error('Project source media is missing.');
    const job = await step.do('load target export retry generation', () => deps.jobs.getForProject(params.projectId, params.jobId, params.userId));
    if (!job) throw new Error('Job not found.');
    if (job.status === 'cancelled') throw new JobCancelledError();
    if (!Number.isInteger(job.retryCount) || job.retryCount < 0) throw new Error('Job retry generation is invalid.');
    const retryCount = job.retryCount;

    const segments = await step.do('load target export segments', () => deps.segments.list(params.projectId, params.userId));
    if (segments.length === 0) throw new Error('No segments are available for export.');
    const translations = await loadOrTranslateTarget(targetParams, project, segments, retryCount, deps, step);
    const speakerRows = deps.speakers ? await step.do('load target export speaker voices', () => deps.speakers!.list(params.projectId, params.userId)) : [];
    const speakers = new Map(speakerRows.map((speaker) => [speaker.id, speaker]));

    await step.do('mark target export processing', async () => {
      await deps.multilang!.setExportRunning(params.projectId, params.exportId!, params.userId);
      await deps.projects.setStatus(params.projectId, params.userId, 'processing');
      await deps.jobs.setProgress(params.jobId, 0.08, 'generating_voice');
    });

    const clips: ExportClip[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      await step.do(`check cancellation before target voice ${segment.id}`, ensureActive);
      const translation = translations.get(segment.id);
      if (!translation?.translatedText.trim()) throw new Error(`Segment ${segment.id} has no ${targetLanguage} translation.`);
      const segmentVersion = targetVersion(segment);
      const existingDub = await step.do(`load ${targetLanguage} dub ${segment.id}`, () =>
        deps.multilang!.getDub(params.projectId, segment.id, params.userId, targetLanguage),
      );
      let objectKey = existingDub?.status === 'completed'
        && existingDub.objectKey
        && existingDub.segmentVersion === segmentVersion
        && existingDub.translationVersion === translation.version
        ? existingDub.objectKey
        : null;
      const provider = 'elevenlabs';
      const usageKey = targetOperationKey(params.jobId, retryCount, targetLanguage, 'tts', segment.id, provider);
      const started = await step.do(`load target TTS started ${segment.id}`, () => deps.usage.getByOperation(usageKey, 'started'));
      const completed = await step.do(`load target TTS completed ${segment.id}`, () => deps.usage.getByOperation(usageKey, 'completed'));

      if (objectKey) {
        if (started && !completed) {
          await step.do(`recover target TTS usage ${segment.id}`, async () => {
            const units = await probeTtsSeconds(deps, objectKey!);
            await deps.usage.record({ userId: params.userId, projectId: params.projectId, jobId: params.jobId, kind: 'tts_audio_second', units, provider, phase: 'completed', operationKey: usageKey });
          });
        }
      } else {
        if (completed) throw new Error(`Segment ${segment.id} has completed target TTS usage without a durable artifact.`);
        if (!deps.bucket.put) throw new Error('R2 put is unavailable for voice generation.');
        objectKey = targetAudioObjectKey(params.projectId, targetLanguage, segment.id, segmentVersion);
        await step.do(`generate ${targetLanguage} voice ${segment.id}`, async () => {
          await deps.usage.record({ userId: params.userId, projectId: params.projectId, jobId: params.jobId, kind: 'tts_audio_second', units: 0, provider, phase: 'started', operationKey: usageKey });
          const voice = speakerVoiceId(segment, speakers);
          const input: VoiceGenerateInput = voice
            ? { text: translation.translatedText.trim(), language: targetLanguage, voice }
            : { text: translation.translatedText.trim(), language: targetLanguage };
          const generated = await withProviderTelemetry(deps.telemetry, {
            requestId: params.requestId, actorId: params.userId, projectId: params.projectId, jobId: params.jobId,
            operation: 'voice', provider, errorCode: 'VOICE_PROVIDER_FAILED',
          }, () => deps.voice.generate(input));
          if (!(generated instanceof Response) || !generated.ok) throw new Error('Voice provider returned an invalid response.');
          const audio = await generated.arrayBuffer();
          if (audio.byteLength === 0) throw new Error('Voice provider returned empty audio.');
          await deps.bucket.put!(objectKey!, audio);
          const durationSeconds = await probeTtsSeconds(deps, objectKey!);
          await deps.multilang!.upsertDub({
            segmentId: segment.id, projectId: params.projectId, targetLanguage, status: 'completed', objectKey,
            voiceProvider: provider, voiceId: voice ?? null, translationVersion: translation.version,
            segmentVersion, durationMs: Math.round(durationSeconds * 1000), userId: params.userId,
          });
          if (targetLanguage === 'vi') await deps.segments.setVoiceResult(params.projectId, segment.id, params.userId, objectKey!);
          await deps.usage.record({ userId: params.userId, projectId: params.projectId, jobId: params.jobId, kind: 'tts_audio_second', units: durationSeconds, provider, phase: 'completed', operationKey: usageKey });
        });
      }
      clips.push({ segmentId: segment.id, startMs: segment.startMs, endMs: segment.endMs, objectKey });
      await step.do(`persist target voice progress ${segment.id}`, () => deps.jobs.setProgress(params.jobId, 0.1 + ((index + 1) / segments.length) * 0.55, 'generating_voice'));
    }

    await step.do('check cancellation before target render', ensureActive);
    const renderSeconds = Number(project.durationMs) / 1000;
    if (!Number.isFinite(renderSeconds) || renderSeconds <= 0) throw new Error('Project duration is missing or invalid for render metering.');
    const renderProvider = 'ffmpeg-container';
    const renderKey = targetOperationKey(params.jobId, retryCount, targetLanguage, 'render', params.exportId, renderProvider);
    const rendered = await step.do(`render ${targetLanguage} dubbed media`, async () => {
      await deps.jobs.setProgress(params.jobId, 0.72, 'rendering_export');
      const common = { userId: params.userId, projectId: params.projectId, jobId: params.jobId, kind: 'render_second' as const, units: renderSeconds, provider: renderProvider, operationKey: renderKey };
      await deps.usage.record({ ...common, phase: 'started' });
      const options: ExportRenderOptions = { targetLanguage, exportId: params.exportId! };
      const result = await withProviderTelemetry(deps.telemetry, {
        requestId: params.requestId, actorId: params.userId, projectId: params.projectId, jobId: params.jobId,
        operation: 'render', provider: renderProvider, errorCode: 'MEDIA_RENDER_FAILED',
      }, () => deps.media.renderExport(params.projectId, project.sourceObjectKey!, clips, options));
      const expectedPrefix = `projects/${params.projectId}/exports/${targetLanguage}/${params.exportId}`;
      if (!result.exportObjectKey?.startsWith(expectedPrefix)) throw new Error('Media processor returned an invalid target export object key.');
      await deps.usage.record({ ...common, phase: 'completed' });
      return result;
    });

    await step.do('publish target export', async () => {
      await deps.multilang!.completeExport(params.projectId, params.exportId!, params.userId, rendered.exportObjectKey);
      if (targetLanguage === 'vi') await deps.projects.setExportObject(params.projectId, params.userId, rendered.exportObjectKey);
      await deps.jobs.complete(params.jobId);
      await reconcileBatchProjectStatus({ projectId: params.projectId, userId: params.userId, batchId: params.batchId! }, deps);
    });
    return { status: 'completed', exportObjectKey: rendered.exportObjectKey };
  } catch (error) {
    try {
      if (params.exportId && deps.multilang) {
        await deps.multilang.failExport(params.projectId, params.exportId, params.userId, isJobCancelledError(error) ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED');
      }
      if (!isJobCancelledError(error)) await deps.jobs.fail(params.jobId, 'EXPORT_FAILED', errorMessage(error));
      if (params.batchId) await reconcileBatchProjectStatus({ projectId: params.projectId, userId: params.userId, batchId: params.batchId }, deps);
    } catch {
      // Preserve the target export failure if durable failure recording also fails.
    }
    throw error;
  }
}

async function runLegacyExportPipeline(
  params: ExportWorkflowParams,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): Promise<{ status: 'completed'; exportObjectKey: string }> {
  const ensureActive = () => assertJobActive(deps.jobs, params.projectId, params.jobId, params.userId);
  try {
    const project = await step.do('authorize export project', async () => deps.projects.getByIdForUser(params.projectId, params.userId));
    if (!project) throw new Error('Project not found.');
    if (!project.sourceObjectKey) throw new Error('Project source media is missing.');
    const job = await step.do('load export retry generation', async () => deps.jobs.getForProject(params.projectId, params.jobId, params.userId));
    if (!job) throw new Error('Job not found.');
    if (job.status === 'cancelled') throw new JobCancelledError();
    if (!Number.isInteger(job.retryCount) || job.retryCount < 0) throw new Error('Job retry generation is invalid.');
    const retryCount = job.retryCount;
    const segments = await step.do('load translated export segments', async () => deps.segments.list(params.projectId, params.userId));
    if (segments.length === 0) throw new Error('No translated segments are available for export.');
    const emptyTranslation = segments.find((segment) => !segment.translatedText.trim());
    if (emptyTranslation) throw new Error(`Segment ${emptyTranslation.id} has no translated text.`);
    const speakerRows = deps.speakers ? await step.do('load export speaker voices', async () => deps.speakers!.list(params.projectId, params.userId)) : [];
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
      let objectKey = segment.voiceStatus === 'completed' && segment.dubbedObjectKey ? segment.dubbedObjectKey : null;
      const ttsProvider = 'elevenlabs';
      const ttsKey = operationKey(params.jobId, retryCount, 'tts', segment.id, ttsProvider);
      const started = await step.do(`load TTS started usage ${segment.id}`, async () => deps.usage.getByOperation(ttsKey, 'started'));
      const completed = await step.do(`load TTS completed usage ${segment.id}`, async () => deps.usage.getByOperation(ttsKey, 'completed'));
      if (objectKey) {
        if (started && !completed) {
          await step.do(`recover TTS usage ${segment.id}`, async () => {
            const units = await probeTtsSeconds(deps, objectKey!);
            await deps.usage.record({ userId: params.userId, projectId: params.projectId, jobId: params.jobId, kind: 'tts_audio_second', units, provider: ttsProvider, phase: 'completed', operationKey: ttsKey });
          });
        }
      } else {
        if (completed) throw new Error(`Segment ${segment.id} has completed TTS usage without a durable voice artifact.`);
        objectKey = legacyAudioObjectKey(params.projectId, segment.id);
        await step.do(`generate voice ${segment.id}`, async () => {
          if (!deps.bucket.put) throw new Error('R2 put is unavailable for voice generation.');
          await deps.usage.record({ userId: params.userId, projectId: params.projectId, jobId: params.jobId, kind: 'tts_audio_second', units: 0, provider: ttsProvider, phase: 'started', operationKey: ttsKey });
          const text = segment.translatedText.trim();
          const voice = speakerVoiceId(segment, speakers);
          const input: VoiceGenerateInput = voice ? { text, language: 'vi', voice } : { text, language: 'vi' };
          const generated = await withProviderTelemetry(deps.telemetry, {
            requestId: params.requestId, actorId: params.userId, projectId: params.projectId, jobId: params.jobId,
            operation: 'voice', provider: ttsProvider, errorCode: 'VOICE_PROVIDER_FAILED',
          }, () => deps.voice.generate(input));
          if (!(generated instanceof Response)) throw new Error('Voice provider returned an unsupported response.');
          if (!generated.ok) throw new Error(`Voice provider failed (${generated.status}).`);
          const audio = await generated.arrayBuffer();
          if (audio.byteLength === 0) throw new Error('Voice provider returned empty audio.');
          await deps.bucket.put(objectKey!, audio);
          await deps.segments.setVoiceResult(params.projectId, segment.id, params.userId, objectKey!);
          const units = await probeTtsSeconds(deps, objectKey!);
          await deps.usage.record({ userId: params.userId, projectId: params.projectId, jobId: params.jobId, kind: 'tts_audio_second', units, provider: ttsProvider, phase: 'completed', operationKey: ttsKey });
        });
      }
      clips.push({ segmentId: segment.id, startMs: segment.startMs, endMs: segment.endMs, objectKey });
      await step.do(`persist voice progress ${segment.id}`, async () => deps.jobs.setProgress(params.jobId, 0.1 + ((index + 1) / segments.length) * 0.55, 'generating_voice'));
    }
    await step.do('check cancellation before export render', ensureActive);
    await step.do('mark render stage', async () => deps.jobs.setProgress(params.jobId, 0.72, 'rendering_export'));
    const renderSeconds = Number(project.durationMs) / 1000;
    if (!Number.isFinite(renderSeconds) || renderSeconds <= 0) throw new Error('Project duration is missing or invalid for render metering.');
    const renderProvider = 'ffmpeg-container';
    const renderKey = operationKey(params.jobId, retryCount, 'render', 'final', renderProvider);
    const rendered = await step.do('render final dubbed media', async () => {
      const common = { userId: params.userId, projectId: params.projectId, jobId: params.jobId, kind: 'render_second' as const, units: renderSeconds, provider: renderProvider, operationKey: renderKey };
      await deps.usage.record({ ...common, phase: 'started' });
      const result = await withProviderTelemetry(deps.telemetry, {
        requestId: params.requestId, actorId: params.userId, projectId: params.projectId, jobId: params.jobId,
        operation: 'render', provider: renderProvider, errorCode: 'MEDIA_RENDER_FAILED',
      }, () => deps.media.renderExport(params.projectId, project.sourceObjectKey!, clips));
      if (!result.exportObjectKey?.startsWith(`projects/${params.projectId}/export/`)) throw new Error('Media processor returned an invalid export object key.');
      await deps.usage.record({ ...common, phase: 'completed' });
      return result;
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
      try { await deps.projects.setStatus(params.projectId, params.userId, 'cancelled'); } catch { /* preserve cancellation */ }
      throw error;
    }
    try {
      await deps.jobs.fail(params.jobId, 'EXPORT_FAILED', errorMessage(error));
      await deps.projects.setStatus(params.projectId, params.userId, 'needs_review');
    } catch { /* preserve original export failure */ }
    throw error;
  }
}

export async function runExportPipeline(
  params: ExportWorkflowParams,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): Promise<{ status: 'completed'; exportObjectKey: string }> {
  if (params.exportId || params.targetLanguage || params.batchId) return runTargetExportPipeline(params, deps, step);
  return runLegacyExportPipeline(params, deps, step);
}
