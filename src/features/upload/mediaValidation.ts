export const MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 3 * 60 * 60;
const extensions = ['mp4', 'webm', 'mkv', 'mov'];

export type DurationReader = (file: File) => Promise<number>;

export function validateMediaFile(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext || !extensions.includes(ext)) return 'Định dạng hỗ trợ: MP4, WebM, MKV hoặc MOV.';
  if (file.size > MAX_MEDIA_BYTES) return 'Video vượt quá giới hạn 5 GB.';
  return null;
}

export function validateMediaDuration(seconds: number): string | null {
  return seconds > MAX_DURATION_SECONDS ? 'Video vượt quá giới hạn 3 giờ.' : null;
}

export async function validateMediaSelection(file: File, readDuration: DurationReader): Promise<string | null> {
  const fileError = validateMediaFile(file);
  if (fileError) return fileError;
  const durationSeconds = await readDuration(file);
  return validateMediaDuration(durationSeconds);
}

export function readMediaDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;

    const cleanup = () => {
      video.removeAttribute('src');
      URL.revokeObjectURL(url);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      const duration = video.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) reject(new Error('INVALID_MEDIA_DURATION'));
      else resolve(duration);
    };
    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('MEDIA_METADATA_UNREADABLE'));
    };
    video.src = url;
  });
}
