import type { ProjectStatus } from '../db/projects';
import type { JobStore } from '../db/jobs';
import type { VoiceGenerateInput } from '../services/voice/types';
import { assertJobActive, isJobCancelledError, type JobStatusReader } from './jobCancellation';

export type ExportWorkflowParams = { projectId: string; userId: string; jobId: string; usageAttempt?: number };

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

export type ExportPipelineDeps = {
  projects: {
    getByIdForUser(projectId: string, userId: string): Promise<ExportProject | null>;
    setStatus(projectId: string, userId: string, status: ProjectStatus): Promise<void>;
    setExportObject(projectId: string, userId: string, objectKey: string): Promise<void>;
  };
  jobs: JobStatusReader & Pick<JobStore, 'setProgress' | 'fail' | 'complete'>;
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
    renderExport(projectId: string, sourceObjectKey: string, clips: ExportClip[]): Promise<{ exportObjectKey: string }>;
  };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown export failure.';
}

function audioObjectKey(projectId: string, segmentId: string): string {
  return `projects/${projectId}/dubbed/${segmentId}.mp3`;
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

      if (!objectKey) {
        objectKey = audioObjectKey(params.projectId, segment.id);
        await step.do(`generate voice ${segment.id}`, async () => {
          if (!deps.bucket.put) throw new Error('R2 put is unavailable for voice generation.');
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

    const rendered = await step.do('render final dubbed media', async () =>
      deps.media.renderExport(params.projectId, project.sourceObjectKey!, clips),
    );
    if (!rendered.exportObjectKey?.startsWith(`projects/${params.projectId}/export/`)) {
      throw new Error('Media processor returned an invalid export object key.');
    }

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
