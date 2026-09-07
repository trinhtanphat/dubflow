import { createProject, getProject, type CloudProject } from '../projects/projectApi';
import { startProcessing, type StartProcessingResult } from '../projects/jobApi';
import { uploadMediaMultipart, type CompletedUpload } from './multipartApi';
import {
  completePreparedAsrUpload,
  uploadPreparedAsrChunk,
  type StoredPreparedAsrChunk,
} from './preparedAsrApi';
import { prepareSourceAudioChunks, type PreparedAsrChunk, type SourceAudioPreparation } from './sourceAudioPrep';

export type CloudUploadFlowDeps = {
  createProject: (title: string, sourceLanguage: CloudProject['sourceLanguage']) => Promise<CloudProject>;
  uploadMedia: (
    projectId: string,
    file: File,
    fetchImpl?: typeof fetch,
    onProgress?: (ratio: number) => void,
  ) => Promise<CompletedUpload>;
  getProject: (projectId: string) => Promise<CloudProject>;
  prepareSourceAudio: (
    file: File,
    consumeChunk: (chunk: PreparedAsrChunk) => Promise<void> | void,
  ) => Promise<SourceAudioPreparation>;
  uploadPreparedAsrChunk: (
    projectId: string,
    sourceGeneration: number,
    chunk: PreparedAsrChunk,
  ) => Promise<StoredPreparedAsrChunk>;
  completePreparedAsrUpload: (
    projectId: string,
    sourceGeneration: number,
    durationMs: number,
    chunks: StoredPreparedAsrChunk[],
  ) => Promise<unknown>;
  startProcessing: (projectId: string) => Promise<StartProcessingResult>;
};

const defaultDeps: CloudUploadFlowDeps = {
  createProject,
  uploadMedia: uploadMediaMultipart,
  getProject,
  prepareSourceAudio: prepareSourceAudioChunks,
  uploadPreparedAsrChunk,
  completePreparedAsrUpload,
  startProcessing,
};

export type CloudUploadFlowResult = {
  project: CloudProject;
  upload: CompletedUpload;
  job: StartProcessingResult;
};

function projectTitle(filename: string): string {
  const stripped = filename.replace(/\.[^.]+$/, '').trim();
  return stripped || 'YupVox project';
}

function currentSourceGeneration(project: CloudProject, upload: CompletedUpload): number {
  if (project.sourceObjectKey !== upload.objectKey) {
    throw new Error('Uploaded source changed before browser audio preparation.');
  }
  const generation = Number(project.sourceGeneration);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error('Uploaded source generation is unavailable.');
  }
  return generation;
}

export async function runCloudUploadFlow(
  file: File,
  sourceLanguage: CloudProject['sourceLanguage'],
  deps: CloudUploadFlowDeps = defaultDeps,
  onProgress: (ratio: number) => void = () => {},
): Promise<CloudUploadFlowResult> {
  const createdProject = await deps.createProject(projectTitle(file.name), sourceLanguage);
  const upload = await deps.uploadMedia(createdProject.id, file, fetch, onProgress);
  const project = await deps.getProject(createdProject.id);
  const sourceGeneration = currentSourceGeneration(project, upload);
  const storedChunks: StoredPreparedAsrChunk[] = [];

  const preparation = await deps.prepareSourceAudio(file, async (chunk) => {
    const stored = await deps.uploadPreparedAsrChunk(project.id, sourceGeneration, chunk);
    storedChunks.push(stored);
  });
  if (preparation.required) {
    if (storedChunks.length !== preparation.chunkCount) {
      throw new Error('Prepared ASR chunk count does not match browser preparation.');
    }
    await deps.completePreparedAsrUpload(
      project.id,
      sourceGeneration,
      preparation.durationMs,
      storedChunks,
    );
  }

  const job = await deps.startProcessing(project.id);
  return { project, upload, job };
}
