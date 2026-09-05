import { MAX_MEDIA_DURATION_SECONDS } from '../../../shared/mediaPolicy';
import type { ProjectStore } from '../db/projects';
import type { JobStore } from '../db/jobs';
import type { SegmentStore } from '../db/segments';
import type { R2BucketLike } from '../cloudflare/r2';
import type { MediaProcessor } from '../services/media/types';
import type { AsrProvider } from '../services/asr/types';
import { normalizeAsrChunks } from '../services/asr/normalize';
import type { TranslationProvider } from '../services/translation/types';

export type DubbingWorkflowParams = { projectId: string; userId: string; jobId: string };

export interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

type PipelineProjects = Pick<ProjectStore, 'getByIdForUser' | 'setStatus'>;
type PipelineJobs = Pick<JobStore, 'setProgress' | 'fail' | 'complete'>;
type PipelineSegments = Pick<SegmentStore, 'replaceFromAsr' | 'setTranslationResult'>;

export type DubbingPipelineDeps = {
  projects: PipelineProjects;
  jobs: PipelineJobs;
  media: Pick<MediaProcessor, 'probe' | 'extractAudioChunks'>;
  bucket: Pick<R2BucketLike, 'get'>;
  asr: AsrProvider;
  segments: PipelineSegments;
  translation: TranslationProvider;
};

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown pipeline failure.';
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
  try {
    const project = await step.do('authorize project', async () => deps.projects.getByIdForUser(params.projectId, params.userId));
    if (!project) throw new Error('Project not found.');
    if (!project.sourceObjectKey) throw new Error('Project source media is missing.');

    await step.do('mark processing', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'processing');
      await deps.jobs.setProgress(params.jobId, 0.05, 'preparing');
    });

    failureCode = 'MEDIA_PROCESSOR_FAILED';
    const metadata = await step.do('probe source media', async () => deps.media.probe(project.sourceObjectKey!));
    if (!Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0 || metadata.durationMs > MAX_MEDIA_DURATION_SECONDS * 1000) {
      throw new Error('Source media duration is invalid or exceeds 3 hours.');
    }
    await step.do('persist source duration', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'processing', metadata.durationMs);
      await deps.jobs.setProgress(params.jobId, 0.12, 'extracting_audio');
    });

    const chunks = await step.do('extract bounded audio chunks', async () =>
      deps.media.extractAudioChunks(params.projectId, project.sourceObjectKey!),
    );
    if (chunks.length === 0) throw new Error('FFmpeg returned no audio chunks.');

    failureCode = 'ASR_FAILED';
    const normalizedInputs = [] as Array<{ projectId: string; chunkId: string; offsetMs: number; segments: Awaited<ReturnType<AsrProvider['transcribe']>>['segments'] }>;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const asrResult = await step.do(`transcribe audio chunk ${index + 1}`, async () => {
        const audio = await readChunk(deps.bucket, chunk.objectKey);
        return deps.asr.transcribe(audio, { sourceLanguage: project.sourceLanguage });
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
      const translated = await step.do(`translate segments ${offset + 1}-${offset + batch.length}`, async () =>
        deps.translation.translateBatch(
          batch.map((segment) => ({ id: segment.id, text: segment.sourceText })),
          project.sourceLanguage,
          'vi',
        ),
      );
      const byId = new Map(translated.map((item) => [item.id, item]));
      await step.do(`persist translations ${offset + 1}-${offset + batch.length}`, async () => {
        for (const segment of batch) {
          const result = byId.get(segment.id);
          if (!result) throw new Error(`Missing translation result for ${segment.id}.`);
          await deps.segments.setTranslationResult(params.projectId, segment.id, params.userId, result.text, 'workers-ai');
        }
      });
      const progress = 0.7 + Math.min(0.25, ((offset + batch.length) / Math.max(1, persisted.length)) * 0.25);
      await step.do(`persist translation progress ${offset + 1}`, async () => deps.jobs.setProgress(params.jobId, progress, 'translating'));
    }

    failureCode = 'PIPELINE_FAILED';
    await step.do('mark review ready', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'needs_review');
      await deps.jobs.complete(params.jobId, 'needs_review');
    });
    return { status: 'needs_review', segmentCount: persisted.length };
  } catch (error) {
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
