export const LOCAL_INFERENCE_ASR = {
  provider: 'browser-whisper',
  model: 'onnx-community/whisper-tiny.en',
  revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
} as const;

export const LOCAL_INFERENCE_TRANSLATION = {
  provider: 'browser-opus-mt',
  model: 'Xenova/opus-mt-en-vi',
  revision: '3f5f449333cbc7ecaa9eec16ee9e37682f036b8e',
} as const;

export const LOCAL_INFERENCE_MAX_SOURCE_BYTES = 24 * 1024 * 1024;
export const LOCAL_INFERENCE_MAX_DURATION_MS = 300_000;
export const LOCAL_INFERENCE_MAX_SEGMENTS = 500;
export const LOCAL_INFERENCE_MAX_COMMIT_BYTES = 2 * 1024 * 1024;
export const LOCAL_INFERENCE_DURATION_TOLERANCE_MS = 1_000;

export function browserLocalSpeakerId(projectId: string): string {
  return `browser-local:${projectId}:speaker-1`;
}
