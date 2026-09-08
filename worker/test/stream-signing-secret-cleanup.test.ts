import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'worker', 'src');
const LEGACY_ALIAS = 'STREAM_SOURCE_SIGNING_SECRET';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  }).filter((path) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(path));
}

describe('R2-only media signing secret cleanup', () => {
  it('contains no active worker source alias for the retired Stream signing secret', () => {
    const matches = sourceFiles(ROOT)
      .filter((path) => readFileSync(path, 'utf8').includes(LEGACY_ALIAS))
      .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'))
      .sort();

    expect(matches, `legacy aliases remain in: ${matches.join(', ')}`).toEqual([]);
  });
});
