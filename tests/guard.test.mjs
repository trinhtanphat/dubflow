import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasGithubActions } from '../scripts/verify-no-github-actions.mjs';

test('hasGithubActions returns false when workflows directory is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dubflow-no-actions-'));
  try {
    assert.equal(await hasGithubActions(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hasGithubActions returns true when .github/workflows exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dubflow-actions-'));
  try {
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    assert.equal(await hasGithubActions(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
