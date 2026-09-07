import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const EXEMPT_ACTORS = new Set([
  'dependabot[bot]',
  'renovate[bot]',
  'github-actions[bot]',
]);

function unquote(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeRepoPath(value, { allowDirectoryGlob = false } = {}) {
  let path = unquote(value);
  if (!path) {
    throw new Error('Reserved path must not be empty.');
  }
  if (path.includes('\\')) {
    throw new Error(`Reserved path must use '/' separators: ${path}`);
  }
  if (path.startsWith('/')) {
    throw new Error(`Reserved path must be repository-relative: ${path}`);
  }
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  if (!path || path.split('/').includes('..')) {
    throw new Error(`Reserved path must not contain parent traversal: ${path || value}`);
  }

  const wildcardIndex = path.indexOf('*');
  if (wildcardIndex !== -1) {
    if (!allowDirectoryGlob || !path.endsWith('/**') || path.slice(0, -3).includes('*')) {
      throw new Error(`Only a single trailing '/**' directory reservation is allowed: ${path}`);
    }
  }

  return path.replace(/\/+/g, '/');
}

export function normalizeReservation(value) {
  const path = normalizeRepoPath(value, { allowDirectoryGlob: true });
  if (path.endsWith('/**')) {
    const prefix = path.slice(0, -3).replace(/\/$/, '');
    if (!prefix) {
      throw new Error('Root-wide /** reservations are not allowed.');
    }
    return { raw: path, kind: 'dir', prefix };
  }
  return { raw: path, kind: 'file', prefix: path };
}

export function reservationCovers(reservation, changedPath) {
  const path = normalizeRepoPath(changedPath);
  if (reservation.kind === 'file') {
    return path === reservation.prefix;
  }
  return path.startsWith(`${reservation.prefix}/`);
}

function reservationsOverlap(a, b) {
  if (a.kind === 'file' && b.kind === 'file') {
    return a.prefix === b.prefix;
  }
  if (a.kind === 'dir' && b.kind === 'file') {
    return b.prefix.startsWith(`${a.prefix}/`);
  }
  if (a.kind === 'file' && b.kind === 'dir') {
    return a.prefix.startsWith(`${b.prefix}/`);
  }
  return (
    a.prefix === b.prefix ||
    a.prefix.startsWith(`${b.prefix}/`) ||
    b.prefix.startsWith(`${a.prefix}/`)
  );
}

function extractField(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^- ${escaped}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) {
    throw new Error(`Missing coordination field: ${name}`);
  }
  const value = unquote(match[1]);
  if (!value) {
    throw new Error(`Coordination field ${name} must not be empty.`);
  }
  return value;
}

function extractCoordinationBlock(body) {
  const source = String(body ?? '');
  const heading = '## Agent coordination';
  const start = source.indexOf(heading);
  if (start === -1) {
    return null;
  }
  const remainder = source.slice(start + heading.length);
  const nextHeading = remainder.search(/^##\s+/m);
  return nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
}

function validateReference(name, value) {
  if (value === 'none' || /^#\d+$/.test(value)) {
    return;
  }
  throw new Error(`${name} must be 'none' or a GitHub issue/PR reference like #123.`);
}

export function parseCoordinationBlock(body) {
  const block = extractCoordinationBlock(body);
  if (block === null) {
    return null;
  }

  const laneKey = extractField(block, 'Lane-Key');
  const carrier = extractField(block, 'Carrier');
  const issue = extractField(block, 'Issue');
  const baseSha = extractField(block, 'Base-SHA');
  const dependsOn = extractField(block, 'Depends-On');
  const handoffFrom = extractField(block, 'Handoff-From');
  const paidResources = extractField(block, 'Paid-Resources');

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(laneKey)) {
    throw new Error('Lane-Key must be stable lowercase kebab-case.');
  }
  if (carrier !== 'primary') {
    throw new Error("Carrier must be 'primary' in coordination policy v1.");
  }
  validateReference('Issue', issue);
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
    throw new Error('Base-SHA must be a full 40-character commit SHA.');
  }
  validateReference('Depends-On', dependsOn);
  validateReference('Handoff-From', handoffFrom);
  if (paidResources !== 'FORBIDDEN') {
    throw new Error('Paid-Resources must be exactly FORBIDDEN.');
  }

  const reservationHeader = block.match(/^- Reserved-Paths:\s*$/m);
  if (!reservationHeader || reservationHeader.index === undefined) {
    throw new Error('Missing coordination field: Reserved-Paths');
  }
  const afterHeader = block.slice(reservationHeader.index + reservationHeader[0].length);
  const reservedPaths = [];
  for (const line of afterHeader.split('\n')) {
    if (!line.trim()) {
      if (reservedPaths.length > 0) break;
      continue;
    }
    const match = line.match(/^\s{2,}-\s+(.+?)\s*$/);
    if (!match) break;
    const reservation = normalizeReservation(match[1]);
    reservedPaths.push(reservation.raw);
  }
  if (reservedPaths.length === 0) {
    throw new Error('Reserved-Paths must contain at least one repository path.');
  }

  return {
    laneKey,
    carrier,
    issue,
    baseSha,
    dependsOn,
    handoffFrom,
    paidResources,
    reservedPaths,
  };
}

export function findReservationOverlaps(current, other) {
  const currentReservations = current.reservedPaths.map(normalizeReservation);
  const otherReservations = other.reservedPaths.map(normalizeReservation);
  const overlaps = [];

  for (const currentReservation of currentReservations) {
    for (const otherReservation of otherReservations) {
      if (reservationsOverlap(currentReservation, otherReservation)) {
        overlaps.push({
          current: currentReservation.raw,
          other: otherReservation.raw,
        });
      }
    }
  }

  return overlaps;
}

export function isExemptActor(login) {
  return EXEMPT_ACTORS.has(String(login ?? ''));
}

export function validateCoordination({ currentPr, openPrs, changedFiles }) {
  const errors = [];
  const warnings = [];
  const actor = currentPr?.user?.login ?? '';

  if (isExemptActor(actor)) {
    return { errors, warnings };
  }

  let current;
  try {
    current = parseCoordinationBlock(currentPr?.body ?? '');
    if (!current) {
      errors.push('PR is missing the required ## Agent coordination block.');
      return { errors, warnings };
    }
  } catch (error) {
    errors.push(`Invalid agent coordination block: ${error.message}`);
    return { errors, warnings };
  }

  const normalizedReservations = current.reservedPaths.map(normalizeReservation);
  for (const changedFile of changedFiles ?? []) {
    if (!normalizedReservations.some((reservation) => reservationCovers(reservation, changedFile))) {
      errors.push(`Changed file is outside Reserved-Paths: ${changedFile}`);
    }
  }

  for (const pr of openPrs ?? []) {
    if (!pr || pr.number === currentPr?.number) continue;

    let other;
    try {
      other = parseCoordinationBlock(pr.body ?? '');
    } catch {
      // A malformed legacy/parallel PR will fail its own policy check after adoption.
      continue;
    }
    if (!other) continue;

    if (other.laneKey === current.laneKey) {
      errors.push(`Lane-Key '${current.laneKey}' is already claimed by open PR #${pr.number}. Continue that carrier or close/handoff it before opening another.`);
      continue;
    }

    for (const overlap of findReservationOverlaps(current, other)) {
      warnings.push(`Reserved path overlaps open PR #${pr.number} lane '${other.laneKey}': ${overlap.current} <-> ${overlap.other}`);
    }
  }

  return { errors, warnings };
}

async function fetchGitHubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${detail.slice(0, 500)}`);
  }
  return response.json();
}

async function fetchAllPages(baseUrl, token) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const batch = await fetchGitHubJson(`${baseUrl}${separator}per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) {
      throw new Error(`Expected paginated GitHub array from ${baseUrl}`);
    }
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

function escapeCommand(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

export async function runCli(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    console.log('Agent coordination: non-pull-request event; skipping live PR reservation check.');
    return 0;
  }

  const eventPath = env.GITHUB_EVENT_PATH;
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!eventPath || !repository || !token) {
    console.error('::error::Agent coordination requires GITHUB_EVENT_PATH, GITHUB_REPOSITORY, and GITHUB_TOKEN.');
    return 1;
  }

  try {
    const event = JSON.parse(await readFile(eventPath, 'utf8'));
    const currentPr = event.pull_request;
    if (!currentPr?.number) {
      throw new Error('pull_request event payload does not contain a PR number.');
    }

    const apiBase = `https://api.github.com/repos/${repository}`;
    const [openPrs, fileRecords] = await Promise.all([
      fetchAllPages(`${apiBase}/pulls?state=open`, token),
      fetchAllPages(`${apiBase}/pulls/${currentPr.number}/files`, token),
    ]);
    const changedFiles = fileRecords.map((record) => record.filename);
    const result = validateCoordination({ currentPr, openPrs, changedFiles });

    for (const warning of result.warnings) {
      console.log(`::warning::${escapeCommand(warning)}`);
    }
    for (const error of result.errors) {
      console.error(`::error::${escapeCommand(error)}`);
    }

    if (result.errors.length > 0) {
      console.error(`Agent coordination failed with ${result.errors.length} error(s).`);
      return 1;
    }

    console.log(`Agent coordination passed for lane '${parseCoordinationBlock(currentPr.body).laneKey}' with ${changedFiles.length} changed file(s).`);
    return 0;
  } catch (error) {
    console.error(`::error::Agent coordination verifier failed: ${escapeCommand(error.message)}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await runCli();
}
