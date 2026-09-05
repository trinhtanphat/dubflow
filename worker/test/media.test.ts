import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/services/media';

describe('parseByteRange', () => {
  it('parses an inclusive HTTP byte range', () => {
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ offset: 100, length: 100, end: 199 });
  });

  it('supports open-ended ranges and rejects invalid ranges', () => {
    expect(parseByteRange('bytes=900-', 1000)).toEqual({ offset: 900, length: 100, end: 999 });
    expect(parseByteRange('bytes=1000-1001', 1000)).toBeNull();
    expect(parseByteRange('items=0-10', 1000)).toBeNull();
  });
});
