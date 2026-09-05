import { createProject, type CloudProject } from '../projects/projectApi';
import { startProcessing, type StartProcessingResult } from '../projects/jobApi';
import { uploadMediaMultipart, type CompletedUpload } from './multipartApi';

export type CloudUploadFlowDeps = {
  createProject: (title: string, sourceLanguage: CloudProject['sourceLanguage']) => Promise<CloudProject>;
  uploadMedia: (
    projectId: string,
    file: File,
    fetchImpl?: typeof fetch,
    onProgress?: (ratio: number) => void,
  ) => Promise<CompletedUpload>;
  startProcessing: (projectId: string) => Promise<StartProcessingResult>;
};

const defaultDeps: CloudUploadFlowDeps = {
  createProject,
  uploadMedia: uploadMediaMultipart,
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

export async function runCloudUploadFlow(
  file: File,
  sourceLanguage: CloudProject['sourceLanguage'],
  deps: CloudUploadFlowDeps = defaultDeps,
  onProgress: (ratio: number) => void = () => {},
): Promise<CloudUploadFlowResult> {
  const project = await deps.createProject(projectTitle(file.name), sourceLanguage);
  const upload = await deps.uploadMedia(project.id, file, fetch, onProgress);
  const job = await deps.startProcessing(project.id);
  return { project, upload, job };
}
