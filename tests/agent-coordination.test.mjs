import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  findReservationOverlaps,
  isExemptActor,
  normalizeReservation,
  parseCoordinationBlock,
  reservationCovers,
  validateCoordination,
} from '../scripts/agent-coordination.mjs';

const BASE_SHA = '7d75b07cd3c17bb6efce8d7a1f3a33dd3d351a81';

function body({ lane = 'voice-browser-piper', paths = ['src/features/voice/**'], paid = 'FORBIDDEN' } = {}) {
  return `## Agent coordination\n- Lane-Key: \`${lane}\`\n- Carrier: \`primary\`\n- Issue: \`#91\`\n- Base-SHA: \`${BASE_SHA}\`\n- Depends-On: \`none\`\n- Handoff-From: \`none\`\n- Paid-Resources: \`${paid}\`\n- Reserved-Paths:\n${paths.map((path) => `  - \`${path}\``).join('\n')}`;
}

test('parses a valid coordination block exactly', () => {
  const parsed = parseCoordinationBlock(body({ paths: ['src/features/voice/**', 'worker/index.ts'] }));
  assert.ok(parsed);
  assert.equal(parsed.laneKey, 'voice-browser-piper');
  assert.equal(parsed.carrier, 'primary');
  assert.equal(parsed.issue, '#91');
  assert.equal(parsed.baseSha, BASE_SHA);
  assert.equal(parsed.dependsOn, 'none');
  assert.equal(parsed.handoffFrom, 'none');
  assert.equal(parsed.paidResources, 'FORBIDDEN');
  assert.deepEqual(parsed.reservedPaths, ['src/features/voice/**', 'worker/index.ts']);
});

test('rejects invalid reservation syntax', () => {
  for (const value of ['../worker/**', '/worker/**', 'src/*/voice/**', 'src\\voice\\file.ts', '']) {
    assert.throws(() => normalizeReservation(value));
  }
});

test('exact and directory reservations cover only intended files', () => {
  const exact = normalizeReservation('worker/index.ts');
  const directory = normalizeReservation('src/features/voice/**');
  assert.equal(reservationCovers(exact, 'worker/index.ts'), true);
  assert.equal(reservationCovers(exact, 'worker/other.ts'), false);
  assert.equal(reservationCovers(directory, 'src/features/voice/client.ts'), true);
  assert.equal(reservationCovers(directory, 'src/features/voice/deep/file.ts'), true);
  assert.equal(reservationCovers(directory, 'src/features/video/file.ts'), false);
});

test('duplicate policy-aware lane key is a hard error', () => {
  const currentPr = { number: 123, user: { login: 'trinhtanphat' }, body: body() };
  const openPrs = [
    currentPr,
    { number: 124, user: { login: 'another-agent' }, body: body({ paths: ['worker/**'] }) },
  ];
  const result = validateCoordination({ currentPr, openPrs, changedFiles: ['src/features/voice/client.ts'] });
  assert.equal(result.errors.some((error) => error.includes('Lane-Key') && error.includes('#124')), true);
});

test('changed file outside reserved paths is a hard error', () => {
  const currentPr = { number: 123, user: { login: 'trinhtanphat' }, body: body() };
  const result = validateCoordination({ currentPr, openPrs: [currentPr], changedFiles: ['worker/index.ts'] });
  assert.equal(result.errors.some((error) => error.includes('worker/index.ts')), true);
});

test('different-lane overlap is warning-only', () => {
  const current = parseCoordinationBlock(body({ lane: 'lane-one', paths: ['src/features/voice/**'] }));
  const other = parseCoordinationBlock(body({ lane: 'lane-two', paths: ['src/features/voice/client.ts'] }));
  assert.ok(current && other);
  assert.deepEqual(findReservationOverlaps(current, other), [
    { current: 'src/features/voice/**', other: 'src/features/voice/client.ts' },
  ]);

  const currentPr = { number: 123, user: { login: 'trinhtanphat' }, body: body({ lane: 'lane-one', paths: ['src/features/voice/**'] }) };
  const otherPr = { number: 124, user: { login: 'another-agent' }, body: body({ lane: 'lane-two', paths: ['src/features/voice/client.ts'] }) };
  const result = validateCoordination({ currentPr, openPrs: [currentPr, otherPr], changedFiles: ['src/features/voice/client.ts'] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.some((warning) => warning.includes('#124') && warning.includes('lane-two')), true);
});

test('known automation actors are exempt and normal users are not', () => {
  for (const actor of ['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]']) {
    assert.equal(isExemptActor(actor), true);
  }
  assert.equal(isExemptActor('trinhtanphat'), false);
});

test('root policy, runbook, and PR template preserve coordination contract', async () => {
  const [agents, runbook, template] = await Promise.all([
    readFile(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/AGENT-COORDINATION.md', import.meta.url), 'utf8'),
    readFile(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8'),
  ]);

  for (const required of ['one active primary carrier', 'Paid-Resources', 'FORBIDDEN', 'exact-head', 'Reserved-Paths']) {
    assert.equal(agents.includes(required), true, `AGENTS.md missing ${required}`);
  }
  for (const required of ['CLAIM', 'WORK', 'HANDOFF', 'REFRESH', 'MERGE', 'main drift']) {
    assert.equal(runbook.includes(required), true, `runbook missing ${required}`);
  }
  for (const required of ['Lane-Key', 'Carrier', 'Base-SHA', 'Depends-On', 'Handoff-From', 'Paid-Resources', 'Reserved-Paths']) {
    assert.equal(template.includes(required), true, `PR template missing ${required}`);
  }
});
