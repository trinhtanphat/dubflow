import {
  mediaExtension,
  SUPPORTED_VIDEO_EXTENSIONS,
  validateMediaFile,
} from '../../../shared/mediaPolicy';

export type BeginUploadInput = {
  filename: string;
  sizeBytes: number;
  contentType?: string;
};

export type NormalizedUploadInput = BeginUploadInput & {
  extension: (typeof SUPPORTED_VIDEO_EXTENSIONS)[number];
};

export class UploadInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UploadInputError';
  }
}

const mimeExtensions: Record<string, NormalizedUploadInput['extension']> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
};

function isSupportedExtension(value: string): value is NormalizedUploadInput['extension'] {
  return (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(value);
}

export function normalizeUploadInput(input: BeginUploadInput): NormalizedUploadInput {
  const result = validateMediaFile({ name: input.filename, size: input.sizeBytes, type: input.contentType });
  if (!result.valid) throw new UploadInputError('UPLOAD_MEDIA_INVALID', result.error);

  const fromName = mediaExtension(input.filename);
  const fromMime = input.contentType ? mimeExtensions[input.contentType.toLowerCase().trim()] : undefined;
  const extension = isSupportedExtension(fromName) ? fromName : fromMime;
  if (!extension) throw new UploadInputError('UPLOAD_MEDIA_INVALID', 'Unable to determine a supported video extension.');

  return { ...input, filename: input.filename.trim(), extension };
}
