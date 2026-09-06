import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT ?? 8080);
const MODEL_ID = process.env.DEMUCS_MODEL_ID ?? 'htdemucs';
const MODEL_SIGNATURE = process.env.DEMUCS_MODEL_SIGNATURE ?? '955717e8';
const MODEL_DIGEST = process.env.DEMUCS_MODEL_DIGEST ?? 'sha256:8726e21a';
const MODEL_REPO = process.env.DEMUCS_MODEL_REPO ?? '/opt/demucs-models';
const PROVIDER = 'demucs-container';
const MEDIA_ORIGIN = 'http://media.r2';
const SOURCE_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.wav', '.mp3', '.m4a', '.aac']);

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
  res.end(bytes);
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeSegment(value) {
  const normalized = String(value ?? '').replaceAll(':', '-');
  return /^[A-Za-z0-9._-]{1,200}$/.test(normalized) ? normalized : null;
}

function validateRequest(raw) {
  const projectId = safeSegment(raw.projectId);
  const provider = safeSegment(raw.provider);
  const modelDigest = safeSegment(raw.modelDigest);
  if (!projectId || !provider || !modelDigest) throw new Error('Invalid separation identity.');
  if (!Number.isInteger(raw.sourceRevision) || raw.sourceRevision <= 0) throw new Error('Invalid source revision.');
  if (raw.provider !== PROVIDER || raw.modelId !== MODEL_ID || raw.modelDigest !== MODEL_DIGEST) {
    throw new Error('Unexpected separator model identity.');
  }
  const sourcePrefix = `projects/${projectId}/source/`;
  if (typeof raw.sourceObjectKey !== 'string' || !raw.sourceObjectKey.startsWith(sourcePrefix) || raw.sourceObjectKey.includes('..')) {
    throw new Error('Invalid source object key.');
  }
  const prefix = `projects/${projectId}/separation/${raw.sourceRevision}/${provider}/${modelDigest}`;
  const dialogueObjectKey = `${prefix}/dialogue.wav`;
  const backgroundObjectKey = `${prefix}/background.wav`;
  if (raw.dialogueObjectKey !== dialogueObjectKey || raw.backgroundObjectKey !== backgroundObjectKey) {
    throw new Error('Unexpected separation output key.');
  }
  return { ...raw, projectId, dialogueObjectKey, backgroundObjectKey };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code}): ${stderr.slice(-2000)}`));
    });
  });
}

async function probeDurationMs(path) {
  const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`ffprobe failed: ${Buffer.concat(stderr).toString('utf8').slice(-1000)}`);
  const seconds = Number(Buffer.concat(stdout).toString('utf8').trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid separated stem duration.');
  return Math.round(seconds * 1000);
}

async function mediaGet(objectKey) {
  const response = await fetch(`${MEDIA_ORIGIN}/objects/${encodeURIComponent(objectKey)}`);
  if (!response.ok) throw new Error(`Source media read failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function mediaPut(objectKey, bytes) {
  const response = await fetch(`${MEDIA_ORIGIN}/objects/${encodeURIComponent(objectKey)}`, {
    method: 'PUT',
    headers: { 'content-type': 'audio/wav' },
    body: bytes,
  });
  if (!response.ok) throw new Error(`Separated stem publish failed (${response.status}).`);
}

async function separate(input) {
  const work = await mkdtemp(join(tmpdir(), 'dubflow-separation-'));
  try {
    const suffix = SOURCE_EXTENSIONS.has(extname(input.sourceObjectKey).toLowerCase())
      ? extname(input.sourceObjectKey).toLowerCase()
      : '.media';
    const sourcePath = join(work, `source${suffix}`);
    const outputDir = join(work, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, await mediaGet(input.sourceObjectKey));

    await run('python3', [
      '-m', 'demucs.separate',
      '--repo', MODEL_REPO,
      '-n', MODEL_SIGNATURE,
      '--two-stems', 'vocals',
      '-o', outputDir,
      sourcePath,
    ]);

    const track = basename(sourcePath, suffix);
    const stemDir = join(outputDir, MODEL_SIGNATURE, track);
    const dialoguePath = join(stemDir, 'vocals.wav');
    const backgroundPath = join(stemDir, 'no_vocals.wav');
    const [dialogueBytes, backgroundBytes, dialogueDurationMs, backgroundDurationMs] = await Promise.all([
      readFile(dialoguePath),
      readFile(backgroundPath),
      probeDurationMs(dialoguePath),
      probeDurationMs(backgroundPath),
    ]);
    if (Math.abs(dialogueDurationMs - backgroundDurationMs) > 2000) throw new Error('Separated stem durations diverged.');

    await mediaPut(input.dialogueObjectKey, dialogueBytes);
    await mediaPut(input.backgroundObjectKey, backgroundBytes);
    return {
      dialogueObjectKey: input.dialogueObjectKey,
      backgroundObjectKey: input.backgroundObjectKey,
      durationMs: Math.max(dialogueDurationMs, backgroundDurationMs),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/separate') {
    json(res, 404, { message: 'Not found.' });
    return;
  }
  try {
    const input = validateRequest(await bodyJson(req));
    json(res, 200, await separate(input));
  } catch (error) {
    console.error('separator_request_failed', error instanceof Error ? error.message : 'unknown');
    json(res, 422, { message: error instanceof Error ? error.message : 'Separation failed.' });
  }
});

server.listen(PORT, '0.0.0.0');
