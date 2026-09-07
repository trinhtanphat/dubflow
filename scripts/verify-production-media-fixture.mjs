import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_ORIGIN = 'https://yupvox.qs3d.site';
const TERMINAL_JOB_STATUSES = new Set(['needs_review', 'completed', 'failed', 'cancelled']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function request(fetchImpl, url, init = {}, expectedStatuses = [200]) {
  const response = await fetchImpl(url, init);
  const body = await readJson(response);
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return { response, body };
}

async function waitForJob(fetchImpl, origin, projectId, jobId, options = {}) {
  const attempts = options.attempts ?? 180;
  const delayMs = options.delayMs ?? 4000;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await request(
      fetchImpl,
      `${origin}/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`,
    );
    last = result.body;
    if (last && TERMINAL_JOB_STATUSES.has(last.status)) {
      if (last.status === 'failed' || last.status === 'cancelled') {
        throw new Error(`Job ${jobId} ended ${last.status}: ${last.errorCode ?? 'UNKNOWN'} ${last.errorMessage ?? ''}`.trim());
      }
      return last;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`Job ${jobId} did not reach a terminal state: ${JSON.stringify(last)}`);
}

function assertReady(body) {
  if (
    body?.ready !== true
    || body?.service !== 'dubflow'
    || body?.database !== 'ready'
    || body?.schemaRevision !== 14
    || body?.media?.r2 !== 'ready'
    || body?.media?.remux !== 'ready'
  ) {
    throw new Error(`Production readiness is not schema-14 R2/remux ready: ${JSON.stringify(body)}`);
  }
}

function sanitizeVoiceCapability(body) {
  return {
    provider: typeof body?.provider === 'string' ? body.provider : null,
    configured: body?.configured === true,
    cloning: body?.cloning === true,
    preview: body?.preview === true,
  };
}

function assertVoiceCapability(body) {
  if (
    typeof body?.provider !== 'string'
    || !body.provider.trim()
    || body?.configured !== true
    || !Array.isArray(body?.languages)
    || !body.languages.includes('vi')
  ) {
    throw new Error(`Production voice capability is not ready for Vietnamese dubbed export: ${JSON.stringify(body)}`);
  }
}

function assertMp4(bytes, contentType) {
  if (!contentType.toLowerCase().includes('video/mp4')) {
    throw new Error(`Final export is not video/mp4: ${contentType || '<missing>'}`);
  }
  if (bytes.byteLength < 16) throw new Error(`Final MP4 is unexpectedly small: ${bytes.byteLength} bytes`);
  const marker = Buffer.from(bytes).subarray(4, 8).toString('ascii');
  if (marker !== 'ftyp') throw new Error(`Final export does not start with an MP4 ftyp box: ${marker}`);
}

export async function runProductionMediaFixture({
  fetchImpl = fetch,
  origin = PRODUCTION_ORIGIN,
  fixturePath = process.env.PRODUCTION_MEDIA_FIXTURE_PATH,
  pollAttempts,
  pollDelayMs,
} = {}) {
  if (!fixturePath) throw new Error('PRODUCTION_MEDIA_FIXTURE_PATH is required.');
  const media = fs.readFileSync(fixturePath);
  if (media.byteLength === 0) throw new Error('Production media fixture is empty.');

  const readiness = await request(fetchImpl, `${origin}/api/ready`);
  assertReady(readiness.body);

  const voiceCapability = await request(fetchImpl, `${origin}/api/voice/capabilities`);
  const safeVoiceCapability = sanitizeVoiceCapability(voiceCapability.body);
  console.log(`Production voice capability ${JSON.stringify(safeVoiceCapability)}`);
  assertVoiceCapability(voiceCapability.body);

  const title = `prod-r2-fixture-${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await request(fetchImpl, `${origin}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, sourceLanguage: 'en', targetLanguage: 'vi' }),
  }, [201]);
  const projectId = created.body?.id;
  if (!projectId) throw new Error(`Project creation returned no id: ${JSON.stringify(created.body)}`);

  const begun = await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'production-r2-fixture.mp4', sizeBytes: media.byteLength, contentType: 'video/mp4' }),
  }, [201]);
  const { uploadId, objectKey, partSizeBytes } = begun.body ?? {};
  if (!uploadId || !objectKey || !Number.isInteger(partSizeBytes) || partSizeBytes <= 0) {
    throw new Error(`Upload initialization returned an invalid contract: ${JSON.stringify(begun.body)}`);
  }

  const parts = [];
  for (let offset = 0, partNumber = 1; offset < media.byteLength; offset += partSizeBytes, partNumber += 1) {
    const body = media.subarray(offset, Math.min(media.byteLength, offset + partSizeBytes));
    const uploaded = await request(
      fetchImpl,
      `${origin}/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}?objectKey=${encodeURIComponent(objectKey)}`,
      { method: 'PUT', body },
    );
    if (!uploaded.body?.etag) throw new Error(`Upload part ${partNumber} returned no etag: ${JSON.stringify(uploaded.body)}`);
    parts.push({ partNumber, etag: uploaded.body.etag });
  }

  await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectKey, parts }),
  });

  const processing = await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}/process`, {
    method: 'POST',
  }, [202]);
  const processJobId = processing.body?.jobId;
  if (!processJobId) throw new Error(`Process start returned no jobId: ${JSON.stringify(processing.body)}`);
  const processJob = await waitForJob(fetchImpl, origin, projectId, processJobId, {
    attempts: pollAttempts,
    delayMs: pollDelayMs,
  });
  if (processJob.status !== 'needs_review' && processJob.status !== 'completed') {
    throw new Error(`Dubbing job did not become exportable: ${JSON.stringify(processJob)}`);
  }

  const exporting = await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}/export`, {
    method: 'POST',
  }, [202]);
  const exportJobId = exporting.body?.jobId;
  if (!exportJobId) throw new Error(`Export start returned no jobId: ${JSON.stringify(exporting.body)}`);
  const exportJob = await waitForJob(fetchImpl, origin, projectId, exportJobId, {
    attempts: pollAttempts,
    delayMs: pollDelayMs,
  });
  if (exportJob.status !== 'completed') {
    throw new Error(`Export job did not complete: ${JSON.stringify(exportJob)}`);
  }

  const mediaResponse = await fetchImpl(`${origin}/api/projects/${encodeURIComponent(projectId)}/export/media`, {
    headers: { accept: 'video/mp4' },
  });
  if (!mediaResponse.ok) {
    const body = await readJson(mediaResponse);
    throw new Error(`Final media download failed (${mediaResponse.status}): ${JSON.stringify(body)}`);
  }
  const contentType = mediaResponse.headers.get('content-type') ?? '';
  const outputBytes = new Uint8Array(await mediaResponse.arrayBuffer());
  assertMp4(outputBytes, contentType);

  return {
    ok: true,
    origin,
    projectId,
    sourceBytes: media.byteLength,
    processJobId,
    exportJobId,
    outputBytes: outputBytes.byteLength,
    contentType,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runProductionMediaFixture()
    .then((result) => console.log(`Production R2 media fixture PASS ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
