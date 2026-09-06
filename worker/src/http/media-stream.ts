import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { parseByteRange } from '../services/media';

export class MediaObjectNotFoundError extends Error {
  constructor() {
    super('Media object not found.');
    this.name = 'MediaObjectNotFoundError';
  }
}

function safeDownloadFilename(filename: string): string {
  const sanitized = filename
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160);
  return sanitized || 'download';
}

export async function streamMediaObject(
  bucket: R2ReadableBucketLike,
  objectKey: string,
  request: Request,
  filename: string,
): Promise<Response> {
  const rangeHeader = request.headers.get('range');
  let parsedRange: ReturnType<typeof parseByteRange> = null;
  let totalSize = 0;

  if (rangeHeader) {
    const metadata = bucket.head ? await bucket.head(objectKey) : null;
    if (!metadata) throw new MediaObjectNotFoundError();
    totalSize = metadata.size;
    parsedRange = parseByteRange(rangeHeader, totalSize);
    if (!parsedRange) {
      return new Response(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${totalSize}`,
        },
      });
    }
  }

  const object = await bucket.get(
    objectKey,
    parsedRange ? { range: { offset: parsedRange.offset, length: parsedRange.length } } : undefined,
  );
  if (!object) throw new MediaObjectNotFoundError();
  if (!rangeHeader) totalSize = object.size;

  const headers = new Headers();
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'video/mp4');
  headers.set('Content-Length', String(parsedRange?.length ?? object.size));
  headers.set('Content-Disposition', `attachment; filename="${safeDownloadFilename(filename)}"`);
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (parsedRange) {
    headers.set('Content-Range', `bytes ${parsedRange.offset}-${parsedRange.end}/${totalSize}`);
  }

  return new Response(object.body, {
    status: parsedRange ? 206 : 200,
    headers,
  });
}
