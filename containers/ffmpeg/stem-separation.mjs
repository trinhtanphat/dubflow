import { execFile, spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { createWriteStream, openAsBlob } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STEM_ENDPOINT = 'https://api.elevenlabs.io/v1/music/stem-separation';

function validProjectId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(value);
}

export function validateStemSeparationInput(input) {
  if (!input || !validProjectId(input.projectId)) throw new Error('Invalid projectId.');
  if (typeof input.objectKey !== 'string' || !input.objectKey.startsWith(`projects/${input.projectId}/source/`)) {
    throw new Error('Source object is outside the project.');
  }
  if (typeof input.sourceRevision !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(input.sourceRevision)) {
    throw new Error('Invalid sourceRevision.');
  }
  return {
    projectId: input.projectId,
    objectKey: input.objectKey,
    sourceRevision: input.sourceRevision,
  };
}

function stemKind(path) {
  const name = basename(path).toLowerCase().replace(/\.[^.]+$/, '');
  if (/(instrumental|no[-_ ]?vocals?|music|background|accompaniment)/.test(name)) return 'background';
  if (/(^|[-_ ])(?:vocals?|voice|dialogue|speech)(?:$|[-_ ])/.test(name) || /^(vocals?|voice|dialogue|speech)$/.test(name)) {
    return 'dialogue';
  }
  return null;
}

export function classifyTwoStemFiles(entries) {
  const files = entries.filter((entry) => typeof entry === 'string' && /\.(wav|mp3|m4a|flac|ogg)$/i.test(entry));
  if (files.length !== 2) throw new Error('Stem archive must contain exactly two audio files.');
  const dialogue = files.find((entry) => stemKind(entry) === 'dialogue');
  const background = files.find((entry) => stemKind(entry) === 'background');
  if (!dialogue || !background || dialogue === background) {
    throw new Error('Unable to identify dialogue and background stems from provider archive.');
  }
  return { dialogue, background };
}

async function saveResponseBody(response, path) {
  if (!response.body) throw new Error('Stem provider returned an empty body.');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

async function extractZipEntry(zipPath, entry, outputDir) {
  if (entry.includes('..') || entry.startsWith('/') || entry.includes('\\')) {
    throw new Error('Stem archive contains an unsafe entry path.');
  }
  await execFileAsync('unzip', ['-j', '-o', zipPath, entry, '-d', outputDir], { maxBuffer: 1024 * 1024 });
  return join(outputDir, basename(entry));
}

async function normalizeWav(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-nostdin', '-y', '-v', 'error', '-i', inputPath,
    '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', outputPath,
  ], { maxBuffer: 2 * 1024 * 1024 });
}

async function listZipEntries(zipPath) {
  const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 2 * 1024 * 1024 });
  return stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

async function buildProviderAudio(sourcePath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-nostdin', '-y', '-v', 'error', '-i', sourcePath,
    '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', outputPath,
  ], { maxBuffer: 2 * 1024 * 1024 });
}

export async function separateTwoStems({ root, sourcePath, input, uploadFile, fetchImpl = fetch }) {
  const normalized = validateStemSeparationInput(input);
  const providerAudio = join(root, 'stem-source.mp3');
  const archive = join(root, 'stems.zip');
  await buildProviderAudio(sourcePath, providerAudio);

  const audioBlob = await openAsBlob(providerAudio, { type: 'audio/mpeg' });
  const form = new FormData();
  form.append('file', audioBlob, 'source.mp3');
  form.append('stem_variation_id', 'two_stems_v1');
  const response = await fetchImpl(STEM_ENDPOINT, { method: 'POST', body: form });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Stem provider failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}.`);
  }
  await saveResponseBody(response, archive);

  const entries = await listZipEntries(archive);
  const selected = classifyTwoStemFiles(entries);
  const dialogueRaw = await extractZipEntry(archive, selected.dialogue, root);
  const backgroundRaw = await extractZipEntry(archive, selected.background, root);
  const dialogueWav = join(root, 'dialogue.wav');
  const backgroundWav = join(root, 'background.wav');
  await normalizeWav(dialogueRaw, dialogueWav);
  await normalizeWav(backgroundRaw, backgroundWav);

  const prefix = `projects/${normalized.projectId}/stems/${normalized.sourceRevision}`;
  const dialogueObjectKey = `${prefix}/dialogue.wav`;
  const backgroundObjectKey = `${prefix}/background.wav`;
  await uploadFile(dialogueObjectKey, dialogueWav, 'audio/wav');
  await uploadFile(backgroundObjectKey, backgroundWav, 'audio/wav');
  return { dialogueObjectKey, backgroundObjectKey };
}

export async function pipeCommand(command, args, destination) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  await pipeline(child.stdout, createWriteStream(destination));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error(`${command} failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`);
}
