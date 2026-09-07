/// <reference lib="webworker" />

export const BROWSER_ASR_MODEL = {
  task: 'automatic-speech-recognition',
  model: 'onnx-community/whisper-tiny.en',
  revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
  dtype: 'q8',
} as const;
