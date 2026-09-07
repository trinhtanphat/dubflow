export const VIETNAMESE_PIPER_VOICE_ID = 'vi_VN-vais1000-medium';

export type PiperDownloadProgress = {
  percent: number | null;
  url?: string;
};

type RawPiperProgress = {
  loaded?: number;
  total?: number;
  url?: string;
};

export type PiperModule = {
  download(
    voiceId: string,
    onProgress?: (progress: RawPiperProgress) => void,
  ): Promise<unknown>;
  predict(
    input: { text: string; voiceId: string },
    onProgress?: (progress: RawPiperProgress) => void,
  ): Promise<Blob>;
};

export type BrowserPiperRuntime = {
  isSupported(): boolean;
  ensureModel(onProgress?: (progress: PiperDownloadProgress) => void): Promise<void>;
  synthesize(text: string, onProgress?: (progress: PiperDownloadProgress) => void): Promise<Blob>;
};

type BrowserPiperRuntimeOptions = {
  loader?: () => Promise<PiperModule>;
  supported?: () => boolean;
};

function progressValue(progress: RawPiperProgress): PiperDownloadProgress {
  const loaded = Number(progress.loaded);
  const total = Number(progress.total);
  return {
    percent: Number.isFinite(loaded) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(100, Math.round((loaded * 100) / total)))
      : null,
    ...(typeof progress.url === 'string' && progress.url ? { url: progress.url } : {}),
  };
}

function supportsBrowserPiper(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || typeof WebAssembly === 'undefined') {
    return false;
  }
  const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<unknown> };
  return typeof storage?.getDirectory === 'function';
}

async function loadPiper(): Promise<PiperModule> {
  return await import('@mintplex-labs/piper-tts-web') as unknown as PiperModule;
}

export function createBrowserPiperRuntime(options: BrowserPiperRuntimeOptions = {}): BrowserPiperRuntime {
  const loader = options.loader ?? loadPiper;
  const supported = options.supported ?? supportsBrowserPiper;

  return {
    isSupported: supported,
    async ensureModel(onProgress) {
      if (!supported()) throw new Error('Trình duyệt này chưa hỗ trợ giọng Việt cục bộ.');
      const piper = await loader();
      await piper.download(VIETNAMESE_PIPER_VOICE_ID, (progress) => onProgress?.(progressValue(progress)));
    },
    async synthesize(text, onProgress) {
      if (!supported()) throw new Error('Trình duyệt này chưa hỗ trợ giọng Việt cục bộ.');
      const normalized = text.trim();
      if (!normalized) throw new Error('Không thể tạo giọng từ bản dịch trống.');
      const piper = await loader();
      return await piper.predict(
        { text: normalized, voiceId: VIETNAMESE_PIPER_VOICE_ID },
        (progress) => onProgress?.(progressValue(progress)),
      );
    },
  };
}
