import { MAX_MEDIA_DURATION_SECONDS } from '../../../shared/mediaPolicy';
import type { Project, ProjectStatus } from '../db/projects';
import type { DubbingJob, JobStore } from '../db/jobs';
import type { SegmentStore } from '../db/segments';
import type { TranslationContextStore } from '../db/translation-context';
import type { UsageStore } from '../db/usage';
import type { R2BucketLike } from '../cloudflare/r2';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import type { MediaProcessor } from '../services/media/types';
import type { AsrProvider, RemoteAsrProvider } from '../services/asr/types';
import { stitchAsrChunks, type StitchChunk } from '../services/asr/stitch';
import { reconcileSpeakerIds, type ExistingSpeakerCoverage } from '../services/asr/reconcile';
import { isTranslationContextActive } from '../services/translation/context';
import type { TranslationRouter } from '../services/translation/router';
import { assertJobActive, isJobCancelledError } from './jobCancellation';

export type DubbingWorkflowParams = { projectId: string; userId: string; jobId: string; requestId?: string };

export interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

type PipelineProject = Pick<Project, 'id' | 'sourceObjectKey' | 'sourceLanguage'>;
type PipelineProjects = {
  getByIdForUser(projectId: string, userId: string): Promise<PipelineProject | null>;
  setStatus(projectId: string, userId: string, status: ProjectStatus, durationMs?: number): Promise<void>;
};
type PipelineJobs = {
  getForProject(
    projectId: string,
    jobId: string,
    userId: string,
  ): Promise<Pick<DubbingJob, 'status' | 'retryCount'> | null>;
} & Pick<JobStore, 'setProgress' | 'fail' | 'complete'>;
type PipelineSegments = Pick<SegmentStore, 'list' | 'replaceFromAsr' | 'setTranslationResult'>;
type PipelineTranslationContextStore = Pick<TranslationContextStore, 'getContext'>;
type PipelineTranslationRouter = Pick<TranslationRouter, 'translate'>;
type UsageMeter = Pick<UsageStore, 'record'>;
type SourceMedia = {
  prepareSource(projectId: string, userId: string, sourceObjectKey: string): Promise<{
    sourceId: string;
    durationMs: number | null;
    audioUrl: string;
  }>;
};
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type DirectAsrAudio = {
  audio: ArrayBuffer;
  mediaType: string;
};

export type DubbingPipelineDeps = {
  projects: PipelineProjects;
  jobs: PipelineJobs;
  sourceMedia?: SourceMedia;
  media?: Pick<MediaProcessor, 'probe' | 'extractAudioChunks'>;
  bucket?: Pick<R2BucketLike, 'get'>;
  fetcher?: FetchLike;
  asr: AsrProvider & Partial<RemoteAsrProvider>;
  asrProviderId: string;
  segments: PipelineSegments;
  translationContext: PipelineTranslationContextStore;
  translationRouter: PipelineTranslationRouter;
  usage: UsageMeter;
  telemetry: TelemetrySink;
};

const MAX_DIRECT_ASR_DURATION_MS = 300_000;
const MAX_DIRECT_ASR_BYTES = 24 * 1024 * 1024;

class PipelineFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PipelineFailure';
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown pipeline failure.';
}

function providerId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} provider id is missing.`);
  return normalized;
}

function operationKey(jobId: string, retryCount: number, stage: string, item: string, provider: string): string {
  return `job:${jobId}:retry:${retryCount}:${stage}:${item}:${provider}`;
}

function sourceCharacters(texts: string[]): number {
  return Array.from(texts.join('')).length;
}

function validSourceDuration(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= MAX_MEDIA_DURATION_SECONDS * 1000;
}

async function readChunk(bucket: Pick<R2BucketLike, 'get'> | undefined, key: string): Promise<ArrayBuffer> {
  if (!bucket?.get) throw new Error('R2 get is unavailable.');
  const object = await bucket.get(key);
  if (!object) throw new Error(`Audio chunk not found: ${key}`);
  return new Response(object.body).arrayBuffer();
}

function existingSpeakerCoverage(
  segments: Awaited<ReturnType<SegmentStore['list']>>,
): ExistingSpeakerCoverage[] {
  const bySpeaker = new Map<string, ExistingSpeakerCoverage>();
  for (const segment of segments) {
    if (!segment.speakerId) continue;
    const current = bySpeaker.get(segment.speakerId) ?? { speakerId: segment.speakerId, ranges: [] };
    current.ranges.push({ startMs: segment.startMs, endMs: segment.endMs });
    bySpeaker.set(segment.speakerId, current);
  }
  return [...bySpeaker.values()]
    .map((coverage) => ({
      speakerId: coverage.speakerId,
      ranges: [...coverage.ranges].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
    }))
    .sort((a, b) => a.speakerId.localeCompare(b.speakerId));
}

function supportsRemoteAsr(asr: AsrProvider & Partial<RemoteAsrProvider>): asr is AsrProvider & RemoteAsrProvider {
  return typeof asr.transcribeUrl === 'function';
}

async function directAsrAudio(
  audioUrl: string,
  durationMs: number,
  fetcher: FetchLike,
): Promise<DirectAsrAudio> {
  if (durationMs > MAX_DIRECT_ASR_DURATION_MS) {
    throw new PipelineFailure(
      'ASR_LONG_FORM_UNAVAILABLE',
      'Long-form source audio requires a remote-capable ASR provider such as Deepgram.',
    );
  }
  const response = await fetcher(audioUrl);
  if (!response.ok) throw new Error(`ASR source download failed (${response.status}).`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DIRECT_ASR_BYTES) {
    throw new PipelineFailure(
      'ASR_LONG_FORM_UNAVAILABLE',
      'Source audio exceeds the direct Workers AI payload budget; configure Deepgram for remote ASR.',
    );
  }
  const audio = await response.arrayBuffer();
  if (audio.byteLength > MAX_DIRECT_ASR_BYTES) {
    throw new PipelineFailure(
      'ASR_LONG_FORM_UNAVAILABLE',
      'Source audio exceeds the direct Workers AI payload budget; configure Deepgram for remote ASR.',
    );
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
  return { audio, mediaType };
}

export async function runDubbingPipeline(
  params: DubbingWorkflowParams,
  deps: DubbingPipelineDeps,
  step: WorkflowStepLike,
): Promise<{ status: 'needs_review'; segmentCount: number }> {
  let failureCode = 'PIPELINE_FAILED';
  const ensureActive = () => assertJobActive(deps.jobs, params.projectId, params.jobId, params.userId);
  try {
    const project = await step.do('authorize project', async () => deps.projects.getByIdForUser(params.projectId, params.userId));
    if (!project) throw new Error('Project not found.');
    if (!project.sourceObjectKey) throw new Error('Project source media is missing.');

    const job = await step.do('load usage retry generation', async () =>
      deps.jobs.getForProject(params.projectId, params.jobId, params.userId),
    );
    if (!job) throw new Error('Job not found.');
    const retryCount = job.retryCount;
    if (!Number.isInteger(retryCount) || retryCount < 0) throw new Error('Job retry generation is invalid.');
    const asrProvider = providerId(deps.asrProviderId, 'ASR');

    await step.do('mark processing', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'processing');
      await deps.jobs.setProgress(params.jobId, 0.05, 'preparing');
    });

    const stitchInputs: StitchChunk[] = [];

    if (deps.sourceMedia) {
      failureCode = 'MEDIA_SOURCE_FAILED';
      await step.do('check cancellation before source preparation', ensureActive);
      await step.do('mark source preparation', async () => deps.jobs.setProgress(params.jobId, 0.08, 'preparing_source'));
      const source = await step.do('prepare source', async () =>
        deps.sourceMedia!.prepareSource(params.projectId, params.userId, project.sourceObjectKey!),
      );

      failureCode = 'ASR_FAILED';
      await step.do('check cancellation before remote ASR', ensureActive);
      const startedUnits = validSourceDuration(source.durationMs) ? source.durationMs / 1000 : 0;
      const item = `source:${source.sourceId}`;
      const key = operationKey(params.jobId, retryCount, 'asr', item, asrProvider);
      await deps.usage.record({
        userId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        kind: 'asr_audio_second',
        units: startedUnits,
        provider: asrProvider,
        operationKey: key,
        phase: 'started',
      });

      const asrResult = await step.do('transcribe source media', async () => withProviderTelemetry(deps.telemetry, {
        requestId: params.requestId,
        actorId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        operation: 'asr',
        provider: asrProvider,
        errorCode: 'ASR_FAILED',
      }, async () => {
        if (supportsRemoteAsr(deps.asr)) {
          return deps.asr.transcribeUrl(source.audioUrl, { sourceLanguage: project.sourceLanguage });
        }
        if (!validSourceDuration(source.durationMs)) {
          throw new PipelineFailure(
            'ASR_LONG_FORM_UNAVAILABLE',
            'Direct ASR requires a known bounded source duration; configure Deepgram for remote ASR.',
          );
        }
        const directInput = await directAsrAudio(source.audioUrl, source.durationMs, deps.fetcher ?? fetch);
        return deps.asr.transcribe(directInput.audio, {
          sourceLanguage: project.sourceLanguage,
          mediaType: directInput.mediaType,
        });
      }));

      const sourceDurationMs = validSourceDuration(source.durationMs)
        ? source.durationMs
        : validSourceDuration(asrResult.durationMs)
          ? asrResult.durationMs
          : null;
      if (!sourceDurationMs) {
        throw new PipelineFailure('ASR_RESPONSE_INVALID', 'Source media duration is missing, invalid, or exceeds 3 hours.');
      }

      await deps.usage.record({
        userId: params.userId,
        projectId: params.projectId,
        jobId: params.jobId,
        kind: 'asr_audio_second',
        units: sourceDurationMs / 1000,
        provider: asrProvider,
        operationKey: key,
        phase: 'completed',
      });

      await step.do('persist source duration', async () => {
        await deps.projects.setStatus(params.projectId, params.userId, 'processing', sourceDurationMs);
        await deps.jobs.setProgress(params.jobId, 0.12, 'transcribing');
      });

      stitchInputs.push({
        projectId: params.projectId,
        chunkId: `source:${source.sourceId}`,
        chunkOrder: 0,
        offsetMs: 0,
        overlapBeforeMs: 0,
        overlapAfterMs: 0,
        segments: asrResult.segments,
      });
      await step.do('persist remote ASR progress', async () => deps.jobs.setProgress(params.jobId, 0.65, 'transcribing'));
    } else {
      if (!deps.media) throw new Error('Media processor is unavailable.');
      failureCode = 'MEDIA_PROCESSOR_FAILED';
      await step.do('check cancellation before media probe', ensureActive);
      const metadata = await step.do('probe source media', async () => deps.media!.probe(project.sourceObjectKey!));
      if (!Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0 || metadata.durationMs > MAX_MEDIA_DURATION_SECONDS * 1000) {
        throw new Error('Source media duration is invalid or exceeds 3 hours.');
      }
      await step.do('persist source duration', async () => {
        await deps.projects.setStatus(params.projectId, params.userId, 'processing', metadata.durationMs);
        await deps.jobs.setProgress(params.jobId, 0.12, 'extracting_audio');
      });

      await step.do('check cancellation before audio extraction', ensureActive);
      const chunks = await step.do('extract bounded audio chunks', async () =>
        deps.media!.extractAudioChunks(params.projectId, project.sourceObjectKey!),
      );
      if (chunks.length === 0) throw new Error('FFmpeg returned no audio chunks.');

      failureCode = 'ASR_FAILED';
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        await step.do(`check cancellation before ASR chunk ${index + 1}`, ensureActive);
        const asrResult = await step.do(`transcribe audio chunk ${index + 1}`, async () => {
          const audio = await readChunk(deps.bucket, chunk.objectKey);
          const units = chunk.durationMs / 1000;
          if (!Number.isFinite(units) || units < 0) throw new Error('ASR chunk duration is invalid.');
          const key = operationKey(params.jobId, retryCount, 'asr', chunk.objectKey, asrProvider);
          const common = {
            userId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            kind: 'asr_audio_second' as const,
            units,
            provider: asrProvider,
            operationKey: key,
          };
          await deps.usage.record({ ...common, phase: 'started' });
          const result = await withProviderTelemetry(deps.telemetry, {
            requestId: params.requestId,
            actorId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            operation: 'asr',
            provider: asrProvider,
            errorCode: 'ASR_FAILED',
          }, () => deps.asr.transcribe(audio, {
            sourceLanguage: project.sourceLanguage,
            mediaType: 'audio/wav',
          }));
          await deps.usage.record({ ...common, phase: 'completed' });
          return result;
        });
        stitchInputs.push({
          projectId: params.projectId,
          chunkId: chunk.objectKey,
          chunkOrder: index,
          offsetMs: chunk.offsetMs,
          overlapBeforeMs: chunk.overlapBeforeMs,
          overlapAfterMs: chunk.overlapAfterMs,
          segments: asrResult.segments,
        });
        const progress = 0.2 + ((index + 1) / chunks.length) * 0.45;
        await step.do(`persist ASR progress ${index + 1}`, async () => deps.jobs.setProgress(params.jobId, progress, 'transcribing'));
      }
    }

    failureCode = 'PIPELINE_FAILED';
    const existing = await step.do('load existing speaker coverage', async () =>
      deps.segments.list(params.projectId, params.userId),
    );
    const stitched = stitchAsrChunks(stitchInputs);
    const reconciled = reconcileSpeakerIds(stitched, existingSpeakerCoverage(existing));
    const normalized = reconciled.map((segment) => ({
      id: segment.id,
      speakerId: segment.speakerId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      sourceText: segment.text,
    }));
    const persisted = await step.do('replace persisted ASR segments', async () =>
      deps.segments.replaceFromAsr(params.projectId, params.userId, normalized),
    );

    failureCode = 'TRANSLATION_FAILED';
    const context = await step.do('load translation context snapshot', async () =>
      deps.translationContext.getContext(params.projectId, params.userId, 'vi'),
    );
    if (!context) throw new Error('Project translation context not found.');
    const expectedTranslationProvider = isTranslationContextActive(context)
      ? 'workers-ai-contextual'
      : 'workers-ai';

    const batchSize = 25;
    for (let offset = 0; offset < persisted.length; offset += batchSize) {
      const batch = persisted.slice(offset, offset + batchSize);
      await step.do(`check cancellation before translation ${offset + 1}`, ensureActive);
      const routed = await step.do(`translate segments ${offset + 1}-${offset + batch.length}`, async () => {
        const items = batch.map((segment) => ({ id: segment.id, text: segment.sourceText }));
        const units = sourceCharacters(items.map((item) => item.text));
        const key = operationKey(params.jobId, retryCount, 'translation', `batch-${offset}`, expectedTranslationProvider);
        const common = {
          userId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          kind: 'translation_character' as const,
          units,
          provider: expectedTranslationProvider,
          operationKey: key,
        };
        await deps.usage.record({ ...common, phase: 'started' });
        const result = await withProviderTelemetry(deps.telemetry, {
          requestId: params.requestId,
          actorId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          operation: 'translate',
          provider: expectedTranslationProvider,
          errorCode: 'TRANSLATION_FAILED',
        }, () => deps.translationRouter.translate(
          undefined,
          items,
          project.sourceLanguage,
          'vi',
          context,
        ));
        if (result.mode === 'compare') {
          throw new Error('Compare mode cannot be persisted by the dubbing workflow.');
        }

        const usageProvider = result.mode === 'contextual'
          ? 'workers-ai-contextual'
          : result.mode === 'google'
            ? 'google'
            : 'workers-ai';
        if (usageProvider !== expectedTranslationProvider) {
          throw new Error(`Translation provider mismatch: expected ${expectedTranslationProvider}, received ${usageProvider}.`);
        }
        if (result.primary.length !== items.length) {
          throw new Error(`Translation result count mismatch: expected ${items.length}, received ${result.primary.length}.`);
        }
        const expectedIds = new Set(items.map((item) => item.id));
        const seenIds = new Set<string>();
        for (const translated of result.primary) {
          if (!expectedIds.has(translated.id) || seenIds.has(translated.id)) {
            throw new Error(`Translation result id mismatch: ${translated.id}.`);
          }
          if (translated.provider !== usageProvider) {
            throw new Error(`Translation provider mismatch: expected ${usageProvider}, received ${translated.provider}.`);
          }
          seenIds.add(translated.id);
        }
        if (seenIds.size !== expectedIds.size) {
          throw new Error('Translation results are missing one or more segment ids.');
        }

        await deps.usage.record({ ...common, phase: 'completed' });
        return result;
      });

      const byId = new Map(routed.primary.map((item) => [item.id, item]));
      await step.do(`persist translations ${offset + 1}-${offset + batch.length}`, async () => {
        for (const segment of batch) {
          const result = byId.get(segment.id);
          if (!result) throw new Error(`Missing translation result for ${segment.id}.`);
          await deps.segments.setTranslationResult(
            params.projectId,
            segment.id,
            params.userId,
            segment.version,
            result.text,
            routed.mode === 'google' ? 'google' : 'workers-ai',
            routed.contextRevision,
          );
        }
      });
      const progress = 0.7 + Math.min(0.25, ((offset + batch.length) / Math.max(1, persisted.length)) * 0.25);
      await step.do(`persist translation progress ${offset + 1}`, async () => deps.jobs.setProgress(params.jobId, progress, 'translating'));
    }

    failureCode = 'PIPELINE_FAILED';
    await step.do('check cancellation before review completion', ensureActive);
    await step.do('mark review ready', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'needs_review');
      await deps.jobs.complete(params.jobId, 'needs_review');
    });
    return { status: 'needs_review', segmentCount: persisted.length };
  } catch (error) {
    if (isJobCancelledError(error)) {
      try {
        await deps.projects.setStatus(params.projectId, params.userId, 'cancelled');
      } catch {
        // Preserve the cancellation error if the project status write also fails.
      }
      throw error;
    }

    const message = asMessage(error);
    const code = error instanceof PipelineFailure ? error.code : failureCode;
    try {
      await deps.jobs.fail(params.jobId, code, message);
      await deps.projects.setStatus(params.projectId, params.userId, 'failed');
    } catch {
      // Preserve the original pipeline error; failure persistence is best-effort here.
    }
    throw error;
  }
}
