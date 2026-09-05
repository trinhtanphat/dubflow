export type ParsedByteRange = { offset: number; length: number; end: number };

export function parseByteRange(header: string | null, size: number): ParsedByteRange | null {
  if (!header || !Number.isFinite(size) || size <= 0) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(requestedEnd)
    || offset < 0
    || offset >= size
    || requestedEnd < offset
  ) return null;

  const end = Math.min(requestedEnd, size - 1);
  return { offset, end, length: end - offset + 1 };
}
