import type { ProjectStatus } from '../db/projects';
import type { VoiceGenerateInput } from '../services/voice/types';

export type ExportWorkflowParams = { projectId: string; userId: string; jobId: string };

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
  startMs: number;
  endMs: number;
  translatedText: string;
  voiceStatus: string;
  dubbedObjectKey?: string | null;
};

type VoiceResult = Response;

export type ExportPipelineDeps = {
  projects: {
    getByIdForUser(projectId: string, userId: string): Promise<ExportProject | null>;
    setStatus(projectId: string, userId: string, status: ProjectStatus): Promise<void>;
    setExportObject(projectId: string, userId: string, objectKey: string): Promise<void>;
  };
  jobs: {
    setProgress(jobId: string, progress: number, currentStep: string): Promise<void>;
    fail(jobId: string, errorCode: string, errorMessage: string): Promise<void>;
    complete(jobId: string): Promise<void>;
  };
  segments: {
    list(projectId: string, userId: string): Promise<ExportSegment[]>;
    setVoiceResult(projectId: string, segmentId: string, userId: string, objectKey: string): Promise<void>;
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

export async function runExportPipeline(
  params: ExportWorkflowParams,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): Promise<{ status: 'completed'; exportObjectKey: string }> {
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

    await step.do('mark export processing', async () => {
      await deps.projects.setStatus(params.projectId, params.userId, 'processing');
      await deps.jobs.setProgress(params.jobId, 0.05, 'generating_voice');
    });

    const clips: ExportClip[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      let objectKey = segment.voiceStatus === 'completed' && segment.dubbedObjectKey
        ? segment.dubbedObjectKey
        : null;

      if (!objectKey) {
        objectKey = audioObjectKey(params.projectId, segment.id);
        await step.do(`generate voice ${segment.id}`, async () => {
          if (!deps.bucket.put) throw new Error('R2 put is unavailable for voice generation.');
          const generated = await deps.voice.generate({ text: segment.translatedText.trim(), language: 'vi' });
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

    await step.do('mark render stage', async () =>
      deps.jobs.setProgress(params.jobId, 0.72, 'rendering_export'),
    );

    const rendered = await step.do('render final dubbed media', async () =>
      deps.media.renderExport(params.projectId, project.sourceObjectKey!, clips),
    );
    if (!rendered.exportObjectKey?.startsWith(`projects/${params.projectId}/export/`)) {
      throw new Error('Media processor returned an invalid export object key.');
    }

    await step.do('publish final export', async () => {
      await deps.projects.setExportObject(params.projectId, params.userId, rendered.exportObjectKey);
      await deps.projects.setStatus(params.projectId, params.userId, 'completed');
      await deps.jobs.complete(params.jobId);
    });

    return { status: 'completed', exportObjectKey: rendered.exportObjectKey };
  } catch (error) {
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
