export const VIETNAMESE_PIPER_VOICE = 'vi_VN-vais1000-medium' as const;

export type PiperWorkerRequest =
  | { type: 'init' }
  | { type: 'synthesize'; requestId: string; text: string };

export type PiperWorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; requestId?: string; loaded?: number; total?: number }
  | { type: 'result'; requestId: string; pcm: ArrayBuffer }
  | { type: 'error'; requestId?: string; code: string; message: string };
