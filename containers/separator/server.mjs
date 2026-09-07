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
const PROVIDER = process.env.SEPARATION_PROVIDER ?? 'demucs-container-htdemucs-8726e21a';
const PROVIDER_VERSION = process.env.SEPARATION_PROVIDER_VERSION ?? 'demucs@4.0.1;model=htdemucs;digest=sha256:8726e21a';
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
  return /^[A-Za-z0-9._-]{1,200}$/.test(String(value ?? '')) ? String(value) : null;
}

function validateRequest(raw) {
  const projectId = safeSegment(raw.projectId);
  const provider = safeSegment(raw.provider);
  if (!projectId || !provider) throw new Error('Invalid separation identity.');
  if (!Number.isInteger(raw.sourceGeneration) || raw.sourceGeneration <= 0) throw new Error('Invalid source generation.');
  if (raw.provider !== PROVIDER || raw.providerVersion !== PROVIDER_VERSION || raw.modelId !== MODEL_ID || raw.modelDigest !== MODEL_DIGEST) {
    throw new Error('Unexpected separator model identity.');
  }
  const sourcePrefix = `projects/${projectId}/`;
  if (typeof raw.sourceObjectKey !== 'string' || !raw.sourceObjectKey.startsWith(sourcePrefix) || raw.sourceObjectKey.includes('..')) {
    throw new Error('Invalid source object key.');
  }
  const prefix = `projects/${projectId}/stems/${raw.sourceGeneration}/${provider}`;
  const dialogueObjectKey = `${prefix}/dialogue.wav`;
  const backgroundObjectKey = `${prefix}/background.wav`;
  if (raw.dialogueObjectKey !== dialogueObjectKey || raw.backgroundObjectKey !== backgroundObjectKey) {
    throw new Error('Unexpected separation output key.');
  }
  return { ...raw, projectId, provider, dialogueObjectKey, backgroundObjectKey };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr.slice(-2000)}`)));
  });
}

async function mediaGet(objectKey) {
  const response = await fetch(`${MEDIA_ORIGIN}/objects/${encodeURIComponent(objectKey)}`);
  if (!response.ok) throw new Error(`Source media read failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function mediaPut(objectKey, bytes) {
  const response = await fetch(`${MEDIA_ORIGIN}/objects/${encodeURIComponent(objectKey)}`, {
    method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: bytes,
  });
  if (!response.ok) throw new Error(`Separated stem publish failed (${response.status}).`);
}

async function separate(input) {
  const work = await mkdtemp(join(tmpdir(), 'dubflow-separation-'));
  try {
    const suffix = SOURCE_EXTENSIONS.has(extname(input.sourceObjectKey).toLowerCase()) ? extname(input.sourceObjectKey).toLowerCase() : '.media';
    const sourcePath = join(work, `source${suffix}`);
    const outputDir = join(work, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, await mediaGet(input.sourceObjectKey));
    await run('python3', ['-m', 'demucs.separate', '--repo', MODEL_REPO, '-n', MODEL_SIGNATURE, '--two-stems', 'vocals', '-o', outputDir, sourcePath]);
    const track = basename(sourcePath, suffix);
    const stemDir = join(outputDir, MODEL_SIGNATURE, track);
    const dialogueBytes = await readFile(join(stemDir, 'vocals.wav'));
    const backgroundBytes = await readFile(join(stemDir, 'no_vocals.wav'));
    await Promise.all([
      mediaPut(input.dialogueObjectKey, dialogueBytes),
      mediaPut(input.backgroundObjectKey, backgroundBytes),
    ]);
    return {
      provider: PROVIDER,
      providerVersion: PROVIDER_VERSION,
      dialogueObjectKey: input.dialogueObjectKey,
      backgroundObjectKey: input.backgroundObjectKey,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/separate') return json(res, 404, { message: 'Not found.' });
  try {
    const input = validateRequest(await bodyJson(req));
    json(res, 200, await separate(input));
  } catch (error) {
    console.error('separator_request_failed', error instanceof Error ? error.message : 'unknown');
    json(res, 422, { message: error instanceof Error ? error.message : 'Separation failed.' });
  }
});

server.listen(PORT, '0.0.0.0');
