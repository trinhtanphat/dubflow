import { MAX_MEDIA_DURATION_SECONDS } from '../../../shared/mediaPolicy';
import type { Project, ProjectStatus } from '../db/projects';
import type { DubbingJob, JobStore } from '../db/jobs';
import type { SegmentStore } from '../db/segments';
import type { UsageStore } from '../db/usage';
import type { R2BucketLike } from '../cloudflare/r2';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import type { MediaProcessor } from '../services/media/types';
import type { AsrProvider } from '../services/asr/types';
import { normalizeAsrChunks } from '../services/asr/normalize';
import type { TranslationProvider } from '../services/translation/types';
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
type PipelineSegments = Pick<SegmentStore, 'replaceFromAsr' | 'setTranslationResult'>;
type UsageMeter = Pick<UsageStore, 'record'>;

export type DubbingPipelineDeps = {
  projects: PipelineProjects;
  jobs: PipelineJobs;
  media: Pick<MediaProcessor, 'probe' | 'extractAudioChunks'>;
  bucket: Pick<R2BucketLike, 'get'>;
  asr: AsrProvider;
  asrProviderId: string;
  segments: PipelineSegments;
  translation: TranslationProvider;
  translationProviderId: string;
  usage: UsageMeter;
  telemetry: TelemetrySink;
};

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

async function readChunk(bucket: Pick<R2BucketLike, 'get'>, key: string): Promise<ArrayBuffer> {
  if (!bucket.get) throw new Error('R2 get is unavailable.');
  const object = await bucket.get(key);
  if (!object) throw new Error(`Audio chunk not found: ${key}`);
  return new Response(object.body).arrayBuffer();
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
    const translationProvider = providerId(deps.translationProviderId, 'Translation');

    await step.do('mark processing', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'processing');
      await deps.jobs.setProgress(params.jobId, 0.05, 'preparing');
    });

    failureCode = 'MEDIA_PROCESSOR_FAILED';
    await step.do('check cancellation before media probe', ensureActive);
    const metadata = await step.do('probe source media', async () => deps.media.probe(project.sourceObjectKey!));
    if (!Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0 || metadata.durationMs > MAX_MEDIA_DURATION_SECONDS * 1000) {
      throw new Error('Source media duration is invalid or exceeds 3 hours.');
    }
    await step.do('persist source duration', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'processing', metadata.durationMs);
      await deps.jobs.setProgress(params.jobId, 0.12, 'extracting_audio');
    });

    await step.do('check cancellation before audio extraction', ensureActive);
    const chunks = await step.do('extract bounded audio chunks', async () =>
      deps.media.extractAudioChunks(params.projectId, project.sourceObjectKey!),
    );
    if (chunks.length === 0) throw new Error('FFmpeg returned no audio chunks.');

    failureCode = 'ASR_FAILED';
    const normalizedInputs = [] as Array<{ projectId: string; chunkId: string; offsetMs: number; segments: Awaited<ReturnType<AsrProvider['transcribe']>>['segments'] }>;
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
        }, () => deps.asr.transcribe(audio, { sourceLanguage: project.sourceLanguage }));
        await deps.usage.record({ ...common, phase: 'completed' });
        return result;
      });
      normalizedInputs.push({
        projectId: params.projectId,
        chunkId: chunk.objectKey,
        offsetMs: chunk.offsetMs,
        segments: asrResult.segments,
      });
      const progress = 0.2 + ((index + 1) / chunks.length) * 0.45;
      await step.do(`persist ASR progress ${index + 1}`, async () => deps.jobs.setProgress(params.jobId, progress, 'transcribing'));
    }

    failureCode = 'PIPELINE_FAILED';
    const normalized = normalizeAsrChunks(normalizedInputs).map((segment) => ({
      id: segment.id,
      speakerId: segment.speakerId ?? null,
      startMs: segment.startMs,
      endMs: segment.endMs,
      sourceText: segment.text,
    }));
    const persisted = await step.do('replace persisted ASR segments', async () =>
      deps.segments.replaceFromAsr(params.projectId, params.userId, normalized),
    );

    failureCode = 'TRANSLATION_FAILED';
    const batchSize = 25;
    for (let offset = 0; offset < persisted.length; offset += batchSize) {
      const batch = persisted.slice(offset, offset + batchSize);
      await step.do(`check cancellation before translation ${offset + 1}`, ensureActive);
      const translated = await step.do(`translate segments ${offset + 1}-${offset + batch.length}`, async () => {
        const items = batch.map((segment) => ({ id: segment.id, text: segment.sourceText }));
        const units = sourceCharacters(items.map((item) => item.text));
        const key = operationKey(params.jobId, retryCount, 'translation', `batch-${offset}`, translationProvider);
        const common = {
          userId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          kind: 'translation_character' as const,
          units,
          provider: translationProvider,
          operationKey: key,
        };
        await deps.usage.record({ ...common, phase: 'started' });
        const results = await withProviderTelemetry(deps.telemetry, {
          requestId: params.requestId,
          actorId: params.userId,
          projectId: params.projectId,
          jobId: params.jobId,
          operation: 'translate',
          provider: translationProvider,
          errorCode: 'TRANSLATION_FAILED',
        }, () => deps.translation.translateBatch(items, project.sourceLanguage, 'vi'));
        const unexpected = results.find((result) => result.provider !== translationProvider);
        if (unexpected) {
          throw new Error(`Translation provider mismatch: expected ${translationProvider}, received ${unexpected.provider}.`);
        }
        await deps.usage.record({ ...common, phase: 'completed' });
        return results;
      });
      const byId = new Map(translated.map((item) => [item.id, item]));
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
            'workers-ai',
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
    try {
      await deps.jobs.fail(params.jobId, failureCode, message);
      await deps.projects.setStatus(params.projectId, params.userId, 'failed');
    } catch {
      // Preserve the original pipeline error; failure persistence is best-effort here.
    }
    throw error;
  }
}
