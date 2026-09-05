export const MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_MEDIA_DURATION_SECONDS = 3 * 60 * 60;

export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mkv', 'mov'] as const;

const SUPPORTED_EXTENSION_SET = new Set<string>(SUPPORTED_VIDEO_EXTENSIONS);
const SUPPORTED_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'video/quicktime',
]);

export type MediaFileLike = {
  name: string;
  size: number;
  type?: string;
};

export type MediaValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export function mediaExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function validateMediaFile(file: MediaFileLike): MediaValidationResult {
  if (!file.name.trim()) {
    return { valid: false, error: 'Tên tệp video không hợp lệ.' };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { valid: false, error: 'Dung lượng tệp video không hợp lệ.' };
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return { valid: false, error: 'Video vượt quá giới hạn 5 GB.' };
  }

  const extension = mediaExtension(file.name);
  const normalizedType = file.type?.toLowerCase().trim();
  const supportedByExtension = SUPPORTED_EXTENSION_SET.has(extension);
  const supportedByMime = normalizedType ? SUPPORTED_MIME_TYPES.has(normalizedType) : false;

  if (!supportedByExtension && !supportedByMime) {
    return { valid: false, error: 'Định dạng video chưa được hỗ trợ. Dùng MP4, WebM, MKV hoặc MOV.' };
  }

  return { valid: true };
}

export function validateMediaDuration(seconds: number): MediaValidationResult {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { valid: false, error: 'Thời lượng video không hợp lệ.' };
  }
  if (seconds > MAX_MEDIA_DURATION_SECONDS) {
    return { valid: false, error: 'Video vượt quá giới hạn 3 giờ.' };
  }
  return { valid: true };
}
