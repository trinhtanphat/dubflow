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
import {
  DIRECT_ASR_CHUNK_DURATION_MS,
  type SourceAudioChunk,
} from '../services/asr/r2-long-form';
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

type SourceAudioChunkExtractor = (audioUrl: string, durationMs: number) => Promise<SourceAudioChunk[]>;

export type DubbingPipelineDeps = {
  projects: PipelineProjects;
  jobs: PipelineJobs;
  sourceMedia?: SourceMedia;
  media?: Pick<MediaProcessor, 'probe' | 'extractAudioChunks'>;
  bucket?: Pick<R2BucketLike, 'get'>;
  fetcher?: FetchLike;
  extractSourceAudioChunks?: SourceAudioChunkExtractor;
  asr: AsrProvider & Partial<RemoteAsrProvider>;
  asrProviderId: string;
  segments: PipelineSegments;
  translationContext: PipelineTranslationContextStore;
  translationRouter: PipelineTranslationRouter;
  usage: UsageMeter;
  telemetry: TelemetrySink;
};

const MAX_DIRECT_ASR_DURATION_MS = DIRECT_ASR_CHUNK_DURATION_MS;
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

function assertDirectSourceChunk(chunk: SourceAudioChunk, index: number, sourceDurationMs: number): void {
  if (!chunk.chunkId.trim()) throw new Error(`ASR_CHUNK_INVALID: Chunk ${index + 1} id is missing.`);
  if (!Number.isInteger(chunk.offsetMs) || chunk.offsetMs < 0 || chunk.offsetMs >= sourceDurationMs) {
    throw new Error(`ASR_CHUNK_INVALID: Chunk ${index + 1} offset is invalid.`);
  }
  if (!Number.isInteger(chunk.durationMs) || chunk.durationMs <= 0 || chunk.durationMs > MAX_DIRECT_ASR_DURATION_MS) {
    throw new Error(`ASR_CHUNK_INVALID: Chunk ${index + 1} duration is invalid.`);
  }
  if (chunk.offsetMs + chunk.durationMs > sourceDurationMs) {
    throw new Error(`ASR_CHUNK_INVALID: Chunk ${index + 1} exceeds the source duration.`);
  }
  if (!Number.isInteger(chunk.overlapBeforeMs) || chunk.overlapBeforeMs < 0
    || !Number.isInteger(chunk.overlapAfterMs) || chunk.overlapAfterMs < 0) {
    throw new Error(`ASR_CHUNK_INVALID: Chunk ${index + 1} overlap is invalid.`);
  }
  if (!chunk.audio.byteLength || chunk.audio.byteLength > MAX_DIRECT_ASR_BYTES) {
    throw new Error(`ASR_CHUNK_INVALID: Chunk ${index + 1} exceeds the direct Workers AI payload budget.`);
  }
}

async function directAsrAudio(
  audioUrl: string,
  durationMs: number,
  fetcher: FetchLike,
): Promise<ArrayBuffer> {
  if (durationMs > MAX_DIRECT_ASR_DURATION_MS) {
    throw new PipelineFailure(
      'ASR_LONG_FORM_UNAVAILABLE',
      'Long-form source audio must be decoded into bounded chunks before direct ASR.',
    );
  }
  const response = await fetcher(audioUrl);
  if (!response.ok) throw new Error(`ASR source download failed (${response.status}).`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DIRECT_ASR_BYTES) {
    throw new PipelineFailure(
      'ASR_LONG_FORM_UNAVAILABLE',
      'Source audio exceeds the direct Workers AI payload budget.',
    );
  }
  const audio = await response.arrayBuffer();
  if (audio.byteLength > MAX_DIRECT_ASR_BYTES) {
    throw new PipelineFailure(
      'ASR_LONG_FORM_UNAVAILABLE',
      'Source audio exceeds the direct Workers AI payload budget.',
    );
  }
  return audio;
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
      await step.do('check cancellation before source ASR', ensureActive);
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

      let providerDurationMs: number | null = null;
      if (supportsRemoteAsr(deps.asr)) {
        const asrResult = await step.do('transcribe source media', async () => withProviderTelemetry(deps.telemetry, {
          requestId: params.requestId,
          actorId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          operation: 'asr',
          provider: asrProvider,
          errorCode: 'ASR_FAILED',
        }, () => deps.asr.transcribeUrl(source.audioUrl, { sourceLanguage: project.sourceLanguage })));
        providerDurationMs = validSourceDuration(asrResult.durationMs) ? asrResult.durationMs : null;
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
        if (!validSourceDuration(source.durationMs)) {
          throw new PipelineFailure(
            'ASR_LONG_FORM_UNAVAILABLE',
            'Direct ASR requires a known bounded source duration.',
          );
        }

        if (source.durationMs <= MAX_DIRECT_ASR_DURATION_MS) {
          const asrResult = await step.do('transcribe source media', async () => withProviderTelemetry(deps.telemetry, {
            requestId: params.requestId,
            actorId: params.userId,
            projectId: params.projectId,
            jobId: params.jobId,
            operation: 'asr',
            provider: asrProvider,
            errorCode: 'ASR_FAILED',
          }, async () => {
            const audio = await directAsrAudio(source.audioUrl, source.durationMs!, deps.fetcher ?? fetch);
            return deps.asr.transcribe(audio, { sourceLanguage: project.sourceLanguage });
          }));
          stitchInputs.push({
            projectId: params.projectId,
            chunkId: `source:${source.sourceId}`,
            chunkOrder: 0,
            offsetMs: 0,
            overlapBeforeMs: 0,
            overlapAfterMs: 0,
            segments: asrResult.segments,
          });
          await step.do('persist direct ASR progress', async () => deps.jobs.setProgress(params.jobId, 0.65, 'transcribing'));
        } else {
          await step.do('check cancellation before source audio chunk extraction', ensureActive);
          const extractChunks = deps.extractSourceAudioChunks;
          if (!extractChunks) {
            throw new PipelineFailure(
              'ASR_LONG_FORM_UNAVAILABLE',
              'Long-form direct ASR requires an explicitly runtime-qualified bounded audio chunk extractor.',
            );
          }
          const chunks = await step.do('extract qualified bounded source audio chunks', async () =>
            extractChunks(source.audioUrl, source.durationMs!),
          );
          if (chunks.length === 0) {
            throw new PipelineFailure('ASR_LONG_FORM_UNAVAILABLE', 'Long-form source produced no bounded audio chunks.');
          }

          let previousEndMs = 0;
          for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            assertDirectSourceChunk(chunk, index, source.durationMs);
            if (chunk.offsetMs < previousEndMs - chunk.overlapBeforeMs) {
              throw new Error(`ASR_CHUNK_INVALID: Chunk ${index + 1} timeline is not monotonic.`);
            }
            previousEndMs = chunk.offsetMs + chunk.durationMs;
            await step.do(`check cancellation before source ASR chunk ${index + 1}`, ensureActive);
            const asrResult = await step.do(`transcribe source audio chunk ${index + 1}`, async () => withProviderTelemetry(deps.telemetry, {
              requestId: params.requestId,
              actorId: params.userId,
              projectId: params.projectId,
              jobId: params.jobId,
              operation: 'asr',
              provider: asrProvider,
              errorCode: 'ASR_FAILED',
            }, () => deps.asr.transcribe(chunk.audio, { sourceLanguage: project.sourceLanguage })));
            stitchInputs.push({
              projectId: params.projectId,
              chunkId: chunk.chunkId,
              chunkOrder: index,
              offsetMs: chunk.offsetMs,
              overlapBeforeMs: chunk.overlapBeforeMs,
              overlapAfterMs: chunk.overlapAfterMs,
              segments: asrResult.segments,
            });
            const progress = 0.2 + ((index + 1) / chunks.length) * 0.45;
            await step.do(`persist source ASR progress ${index + 1}`, async () =>
              deps.jobs.setProgress(params.jobId, progress, 'transcribing'),
            );
          }
        }
      }

      const sourceDurationMs = validSourceDuration(source.durationMs)
        ? source.durationMs
        : providerDurationMs;
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
        await deps.jobs.setProgress(params.jobId, 0.65, 'transcribing');
      });
    } else {
      if (!deps.media) throw new Error('Media processor is unavailable.');
      failureCode = 'MEDIA_PROCESSOR_FAILED';
      await step.do('check cancellation before media probe', ensureActive);
      const probe = await step.do('probe media', async () => deps.media!.probe(project.sourceObjectKey!));
      const sourceDurationMs = probe.durationMs;
      if (!validSourceDuration(sourceDurationMs)) {
        throw new PipelineFailure('MEDIA_DURATION_INVALID', 'Source media duration is missing, invalid, or exceeds 3 hours.');
      }
      const sourceChunks = await step.do('extract source audio', async () =>
        deps.media!.extractAudioChunks(project.sourceObjectKey!),
      );
      if (sourceChunks.length === 0) throw new Error('No audio chunks were extracted from source media.');

      failureCode = 'ASR_FAILED';
      for (let index = 0; index < sourceChunks.length; index += 1) {
        await step.do(`check cancellation before ASR chunk ${index + 1}`, ensureActive);
        const chunk = sourceChunks[index];
        const audio = await step.do(`read audio chunk ${index + 1}`, async () => readChunk(deps.bucket, chunk.key));
        const item = `chunk:${chunk.chunkId}`;
        const key = operationKey(params.jobId, retryCount, 'asr', item, asrProvider);
        await deps.usage.record({
          userId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          kind: 'asr_audio_second',
          units: chunk.durationMs / 1000,
          provider: asrProvider,
          operationKey: key,
          phase: 'started',
        });
        const asrResult = await step.do(`transcribe chunk ${index + 1}`, async () => withProviderTelemetry(deps.telemetry, {
          requestId: params.requestId,
          actorId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          operation: 'asr',
          provider: asrProvider,
          errorCode: 'ASR_FAILED',
        }, () => deps.asr.transcribe(audio, { sourceLanguage: project.sourceLanguage })));
        stitchInputs.push({
          projectId: params.projectId,
          chunkId: chunk.chunkId,
          chunkOrder: index,
          offsetMs: chunk.offsetMs,
          overlapBeforeMs: chunk.overlapBeforeMs,
          overlapAfterMs: chunk.overlapAfterMs,
          segments: asrResult.segments,
        });
        await deps.usage.record({
          userId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          kind: 'asr_audio_second',
          units: chunk.durationMs / 1000,
          provider: asrProvider,
          operationKey: key,
          phase: 'completed',
        });
        const progress = 0.2 + ((index + 1) / sourceChunks.length) * 0.45;
        await step.do(`persist ASR progress ${index + 1}`, async () => deps.jobs.setProgress(params.jobId, progress, 'transcribing'));
      }

      await step.do('persist source duration', async () => {
        await deps.projects.setStatus(params.projectId, params.userId, 'processing', sourceDurationMs);
        await deps.jobs.setProgress(params.jobId, 0.65, 'transcribing');
      });
    }

    const existingSegments = await step.do('load existing speaker coverage', async () =>
      deps.segments.list(params.projectId, params.userId),
    );
    const reconciledInputs = stitchInputs.map((chunk) => ({
      ...chunk,
      segments: reconcileSpeakerIds(existingSpeakerCoverage(existingSegments), chunk.segments),
    }));
    const stitched = stitchAsrChunks(reconciledInputs);
    if (stitched.length === 0) throw new Error('ASR returned no segments.');

    const persistedSegments = await step.do('persist transcript', async () => deps.segments.replaceFromAsr(
      params.projectId,
      params.userId,
      stitched.map((segment) => ({
        id: segment.id,
        speakerId: segment.speakerId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        sourceText: segment.text,
      })),
    ));

    failureCode = 'TRANSLATION_FAILED';
    const context = await step.do('load translation context', async () =>
      deps.translationContext.getContext(params.projectId, params.userId),
    );
    const translation = await step.do('translate transcript', async () => withProviderTelemetry(deps.telemetry, {
      requestId: params.requestId,
      actorId: params.userId,
      projectId: params.projectId,
      jobId: params.jobId,
      operation: 'translation',
      provider: 'translation-router',
      errorCode: 'TRANSLATION_FAILED',
    }, () => deps.translationRouter.translate(
      context && isTranslationContextActive(context) ? 'contextual' : 'default',
      persistedSegments.map((segment) => ({ id: segment.id, text: segment.sourceText })),
      {
        sourceLanguage: project.sourceLanguage,
        targetLanguage: 'vi',
        ...(context && isTranslationContextActive(context) ? {
          context: {
            revision: context.revision,
            style: context.style,
            glossary: context.glossary,
          },
        } : {}),
      },
    )));
    const translations = translation.primary;
    if (translations.length !== persistedSegments.length) {
      throw new Error('Translation result count does not match segment count.');
    }

    const translatedTexts = translations.map((item) => item.text);
    const translationProvider = providerId(translations[0]?.provider ?? translation.mode, 'Translation');
    const translationOperationKey = operationKey(params.jobId, retryCount, 'translation', 'transcript', translationProvider);
    await deps.usage.record({
      userId: params.userId,
      projectId: params.projectId,
      jobId: params.jobId,
      kind: 'translation_character',
      units: sourceCharacters(persistedSegments.map((segment) => segment.sourceText)),
      provider: translationProvider,
      operationKey: translationOperationKey,
      phase: 'started',
    });

    for (let index = 0; index < persistedSegments.length; index += 1) {
      const segment = persistedSegments[index];
      const translated = translations[index];
      const target = await step.do(`persist translation ${index + 1}`, async () => deps.segments.setTranslationResult(
        params.projectId,
        params.userId,
        segment.id,
        translated.text,
        translated.provider,
        translation.contextRevision,
        segment.version,
      ));
      if (!target) throw new Error(`Translation target disappeared for segment ${segment.id}.`);
    }

    await deps.usage.record({
      userId: params.userId,
      projectId: params.projectId,
      jobId: params.jobId,
      kind: 'translation_character',
      units: sourceCharacters(translatedTexts),
      provider: translationProvider,
      operationKey: translationOperationKey,
      phase: 'completed',
    });

    await step.do('mark needs review', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'needs_review');
      await deps.jobs.setProgress(params.jobId, 1, 'needs_review');
      await deps.jobs.complete(params.jobId, 'needs_review');
    });

    return { status: 'needs_review', segmentCount: persistedSegments.length };
  } catch (error) {
    if (isJobCancelledError(error)) {
      throw error;
    }
    const message = asMessage(error);
    try {
      await deps.jobs.fail(params.jobId, failureCode, message);
    } catch (failError) {
      // Preserve the original pipeline failure while still making best effort to
      // keep project state terminal if the durable job write also fails.
      try {
        await deps.projects.setStatus(params.projectId, params.userId, 'failed');
      } catch {
        // Nothing else can be persisted safely from this attempt.
      }
      throw error;
    }
    await deps.projects.setStatus(params.projectId, params.userId, 'failed');
    throw error;
  }
}
