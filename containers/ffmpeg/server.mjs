import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { buildRenderExportArgs, validateRenderExportInput } from './render-export.mjs';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const MAX_JSON_BYTES = 1024 * 1024;

function json(response, status = 200) {
  return { status, body: JSON.stringify(response), headers: { 'content-type': 'application/json; charset=utf-8' } };
}

function r2Url(key) {
  return `http://media.r2/objects/${encodeURIComponent(key)}`;
}

function assertProjectInput(input) {
  if (!input || typeof input.projectId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(input.projectId)) {
    throw new Error('Invalid projectId.');
  }
  if (typeof input.objectKey !== 'string' || !input.objectKey.startsWith(`projects/${input.projectId}/source/`)) {
    throw new Error('Source object is outside the project.');
  }
}

async function readJson(request) {
  let size = 0;
  const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > MAX_JSON_BYTES) throw new Error('Request body is too large.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function downloadObject(key, destination) {
  const response = await fetch(r2Url(key));
  if (!response.ok || !response.body) throw new Error(`Unable to read R2 object (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function uploadFile(key, path, contentType) {
  const body = Readable.toWeb(createReadStream(path));
  const response = await fetch(r2Url(key), {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
    duplex: 'half',
  });
  if (!response.ok) throw new Error(`Unable to write R2 object (${response.status}).`);
}

async function durationMs(path) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe returned an invalid duration.');
  return Math.round(seconds * 1000);
}

async function withSource(input, action) {
  assertProjectInput(input);
  const root = await mkdtemp(join(tmpdir(), 'dubflow-'));
  const source = join(root, 'source-media');
  try {
    await downloadObject(input.objectKey, source);
    return await action({ root, source });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function probe(input) {
  return withSource(input, async ({ source }) => ({ durationMs: await durationMs(source) }));
}

async function extractAudioChunks(input) {
  const chunkSeconds = Number(input.chunkSeconds ?? 300);
  if (!Number.isInteger(chunkSeconds) || chunkSeconds < 30 || chunkSeconds > 600) {
    throw new Error('chunkSeconds must be an integer between 30 and 600.');
  }
  return withSource(input, async ({ root, source }) => {
    const pattern = join(root, 'chunk-%05d.wav');
    await execFileAsync('ffmpeg', [
      '-nostdin', '-y', '-v', 'error', '-i', source,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1', pattern,
    ], { maxBuffer: 1024 * 1024 });

    const files = (await readdir(root)).filter((name) => /^chunk-\d+\.wav$/.test(name)).sort();
    if (files.length === 0) throw new Error('FFmpeg produced no audio chunks.');

    const chunks = [];
    for (let index = 0; index < files.length; index += 1) {
      const filePath = join(root, files[index]);
      const objectKey = `projects/${input.projectId}/audio/${String(index).padStart(5, '0')}.wav`;
      const body = await readFile(filePath);
      const uploaded = await fetch(r2Url(objectKey), { method: 'PUT', body });
      if (!uploaded.ok) throw new Error(`Unable to write audio chunk ${index} to R2 (${uploaded.status}).`);
      chunks.push({
        objectKey,
        offsetMs: index * chunkSeconds * 1000,
        durationMs: await durationMs(filePath),
      });
    }
    return { chunks };
  });
}

async function renderExport(input) {
  validateRenderExportInput(input);
  return withSource(input, async ({ root, source }) => {
    const sourceDurationMs = await durationMs(source);
    const outside = input.clips.find((clip) => clip.endMs > sourceDurationMs);
    if (outside) throw new Error(`Dubbed clip ${outside.segmentId} exceeds source duration.`);

    const clipPaths = [];
    const clipDurationsMs = [];
    for (let index = 0; index < input.clips.length; index += 1) {
      const path = join(root, `dub-${String(index).padStart(5, '0')}.audio`);
      await downloadObject(input.clips[index].objectKey, path);
      clipPaths.push(path);
      clipDurationsMs.push(await durationMs(path));
    }

    const output = join(root, 'dubbed.mp4');
    const args = buildRenderExportArgs({
      sourcePath: source,
      outputPath: output,
      durationMs: sourceDurationMs,
      clips: input.clips,
      clipPaths,
      clipDurationsMs,
    });
    await execFileAsync('ffmpeg', args, { maxBuffer: 4 * 1024 * 1024 });

    const exportObjectKey = `projects/${input.projectId}/export/dubbed.mp4`;
    await uploadFile(exportObjectKey, output, 'video/mp4');
    return { exportObjectKey };
  });
}

async function dispatch(pathname, input) {
  if (pathname === '/probe') return probe(input);
  if (pathname === '/extract-audio-chunks') return extractAudioChunks(input);
  if (pathname === '/render-export') return renderExport(input);
  throw Object.assign(new Error('Not found.'), { statusCode: 404 });
}

createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const out = json({ ok: true, service: 'dubflow-ffmpeg' });
      response.writeHead(out.status, out.headers); response.end(out.body); return;
    }
    if (request.method !== 'POST') {
      const out = json({ error: true, message: 'Method not allowed.' }, 405);
      response.writeHead(out.status, out.headers); response.end(out.body); return;
    }
    const input = await readJson(request);
    const payload = await dispatch(new URL(request.url, 'http://container.local').pathname, input);
    const out = json(payload);
    response.writeHead(out.status, out.headers); response.end(out.body);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const out = json({ error: true, message: error instanceof Error ? error.message : 'FFmpeg processing failed.' }, status);
    response.writeHead(out.status, out.headers); response.end(out.body);
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`DubFlow FFmpeg container listening on ${PORT}`);
});
