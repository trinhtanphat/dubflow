export const LOCAL_INFERENCE_COMMIT_PATH = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/client-inference/vi`;

export type LocalInferenceWorkerPair = {
  asr: Worker;
  translation: Worker;
  dispose(): void;
};

export function createLocalInferenceWorkers(): LocalInferenceWorkerPair {
  const asr = new Worker(new URL('./browserAsr.worker.ts', import.meta.url), { type: 'module' });
  const translation = new Worker(new URL('./browserTranslation.worker.ts', import.meta.url), { type: 'module' });

  return {
    asr,
    translation,
    dispose() {
      asr.terminate();
      translation.terminate();
    },
  };
}
