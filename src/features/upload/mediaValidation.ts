export const MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 3 * 60 * 60;
const extensions = ['mp4', 'webm', 'mkv', 'mov'];

export function validateMediaFile(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext || !extensions.includes(ext)) return 'Định dạng hỗ trợ: MP4, WebM, MKV hoặc MOV.';
  if (file.size > MAX_MEDIA_BYTES) return 'Video vượt quá giới hạn 5 GB.';
  return null;
}

export function validateMediaDuration(seconds: number): string | null {
  return seconds > MAX_DURATION_SECONDS ? 'Video vượt quá giới hạn 3 giờ.' : null;
}
