import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function hasGithubActions(root = process.cwd()) {
  try {
    await access(path.join(root, '.github', 'workflows'));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await hasGithubActions()) {
    console.error('GitHub Actions workflows are forbidden for DubFlow. Remove .github/workflows.');
    process.exitCode = 1;
    return;
  }
  console.log('OK: no .github/workflows directory found. Wrangler-only delivery guard passed.');
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  await main();
}
