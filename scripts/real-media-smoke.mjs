import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.env.SMOKE_BASE_URL ?? 'https://yupvox.qs3d.site').replace(/\/+$/, '');
const mediaPath = process.env.SMOKE_MEDIA_PATH?.trim();
const summaryPath = resolve(process.env.SMOKE_SUMMARY_PATH ?? 'real-media-smoke-summary.json');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 18 * 60 * 1000);
const pollIntervalMs = Number(process.env.SMOKE_POLL_INTERVAL_MS ?? 2_000);

if (!mediaPath) throw new Error('SMOKE_MEDIA_PATH is required.');
if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000) throw new Error('SMOKE_TIMEOUT_MS must be at least 30000.');
if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 250) throw new Error('SMOKE_POLL_INTERVAL_MS must be at least 250.');

const deadlineAt = Date.now() + timeoutMs;
const summary = {
  baseUrl,
  startedAt: new Date().toISOString(),
  status: 'running',
};
let stage = 'startup';

function redact(value) {
  return String(value)
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:signature|token)=)[^&\s"']+/gi, '$1[REDACTED]');
}

function urlFor(path) {
  return path.startsWith('http://') || path.startsWith('https://') ? path : `${baseUrl}${path}`;
}

async function responseText(response) {
  const text = await response.text().catch(() => '');
  return redact(text.slice(0, 2_000));
}

async function rawRequest(path, init = {}, allowedStatuses = [200]) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (body && typeof body === 'object' && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer) && !(body instanceof Blob) && !(body instanceof FormData) && !(body instanceof URLSearchParams) && typeof body.getReader !== 'function') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(body);
  }
  const response = await fetch(urlFor(path), {
    ...init,
    headers,
    body,
    signal: AbortSignal.timeout(Math.min(60_000, Math.max(1_000, deadlineAt - Date.now()))),
  });
  if (!allowedStatuses.includes(response.status)) {
    throw new Error(`${init.method ?? 'GET'} ${path} returned HTTP ${response.status}: ${await responseText(response)}`);
  }
  return response;
}

async function jsonRequest(path, init = {}, allowedStatuses = [200]) {
  const response = await rawRequest(path, init, allowedStatuses);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} returned invalid JSON: ${redact(text.slice(0, 1_000))}`);
  }
}

function terminalDetail(record) {
  const code = record?.errorCode ?? record?.code ?? 'UNKNOWN';
  const message = record?.errorMessage ?? record?.message ?? 'No error message returned.';
  return `${code}: ${message}`;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function poll(label, load, decide) {
  let last;
  while (Date.now() < deadlineAt) {
    last = await load();
    const decision = decide(last);
    if (decision === 'success') return last;
    if (decision instanceof Error) throw decision;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadlineAt - Date.now())));
  }
  throw new Error(`${label} timeout after ${timeoutMs}ms; last state: ${redact(JSON.stringify(last ?? null))}`);
}

function assertMp4(bytes) {
  if (bytes.byteLength < 1_024) throw new Error(`Exported media is unexpectedly small (${bytes.byteLength} bytes).`);
  const view = new Uint8Array(bytes);
  const signature = String.fromCharCode(...view.slice(4, 8));
  if (signature !== 'ftyp') throw new Error(`Exported media does not have an MP4 ftyp signature (received ${JSON.stringify(signature)}).`);
}

async function persistSummary() {
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

async function run() {
  stage = 'read-fixture';
  const media = await readFile(mediaPath);
  if (media.byteLength === 0) throw new Error('Smoke media fixture is empty.');
  summary.fixtureBytes = media.byteLength;

  stage = 'create-project';
  const project = await jsonRequest('/api/projects', {
    method: 'POST',
    body: {
      title: `e2e-smoke-${new Date().toISOString()}`,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
    },
  }, [201]);
  if (!project?.id) throw new Error('Project creation returned no project id.');
  summary.projectId = project.id;
  console.log(`Created smoke project ${project.id}`);

  stage = 'begin-upload';
  const upload = await jsonRequest(`/api/projects/${encodeURIComponent(project.id)}/uploads`, {
    method: 'POST',
    body: {
      filename: 'real-media-smoke.mp4',
      sizeBytes: media.byteLength,
      contentType: 'video/mp4',
    },
  }, [201]);
  if (!upload?.uploadId || !upload?.objectKey) throw new Error('Upload begin returned no uploadId/objectKey.');
  summary.sourceObjectKey = upload.objectKey;

  stage = 'upload-part';
  const partResponse = await rawRequest(
    `/api/projects/${encodeURIComponent(project.id)}/uploads/${encodeURIComponent(upload.uploadId)}/parts/1?objectKey=${encodeURIComponent(upload.objectKey)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4' },
      body: media,
    },
    [200],
  );
  const part = await partResponse.json();
  if (part?.partNumber !== 1 || typeof part?.etag !== 'string' || !part.etag.trim()) {
    throw new Error(`Upload part returned invalid ETag metadata: ${redact(JSON.stringify(part))}`);
  }

  stage = 'complete-upload';
  const completedUpload = await jsonRequest(
    `/api/projects/${encodeURIComponent(project.id)}/uploads/${encodeURIComponent(upload.uploadId)}/complete`,
    {
      method: 'POST',
      body: { objectKey: upload.objectKey, parts: [part] },
    },
    [200],
  );
  if (completedUpload?.objectKey !== upload.objectKey || Number(completedUpload?.size) <= 0) {
    throw new Error(`Upload completion returned invalid object metadata: ${redact(JSON.stringify(completedUpload))}`);
  }
  summary.uploadedBytes = Number(completedUpload.size);

  stage = 'start-dubbing';
  const dubbing = await jsonRequest(`/api/projects/${encodeURIComponent(project.id)}/process`, { method: 'POST' }, [202]);
  if (!dubbing?.jobId) throw new Error('Dubbing launch returned no job id.');
  summary.dubbingJobId = dubbing.jobId;
  summary.dubbingWorkflowId = dubbing.workflowId ?? null;

  stage = 'poll-dubbing-job';
  const dubbingJob = await poll(
    'dubbing job',
    () => jsonRequest(`/api/projects/${encodeURIComponent(project.id)}/jobs/${encodeURIComponent(dubbing.jobId)}`),
    (job) => {
      if (job?.status === 'needs_review') return 'success';
      if (['failed', 'cancelled'].includes(job?.status)) return new Error(`Dubbing job ${job.status}: ${terminalDetail(job)}`);
      return 'continue';
    },
  );
  summary.dubbingJobStatus = dubbingJob.status;

  stage = 'poll-project-review';
  const reviewProject = await poll(
    'project needs_review state',
    () => jsonRequest(`/api/projects/${encodeURIComponent(project.id)}`),
    (current) => {
      if (current?.status === 'needs_review') return 'success';
      if (['failed', 'cancelled'].includes(current?.status)) return new Error(`Project ${current.status} before review.`);
      return 'continue';
    },
  );
  summary.projectStatusAfterDubbing = reviewProject.status;
  summary.streamVideoUid = reviewProject.streamVideoUid ?? null;

  stage = 'start-export';
  const launched = await jsonRequest(`/api/projects/${encodeURIComponent(project.id)}/exports/vi`, {
    method: 'POST',
    body: { output: 'dubbed', audioMode: 'dubbed_only', visualMode: 'standard' },
  }, [202]);
  if (!launched?.exportId || !launched?.jobId) throw new Error('Export launch returned no export/job id.');
  summary.exportId = launched.exportId;
  summary.exportJobId = launched.jobId;
  summary.exportWorkflowId = launched.workflowId ?? null;

  stage = 'poll-export';
  const completedExport = await poll(
    'dubbed export',
    () => jsonRequest(`/api/projects/${encodeURIComponent(project.id)}/exports/vi?output=dubbed`),
    (attempt) => {
      if (attempt?.id && attempt.id !== launched.exportId) {
        return new Error(`Latest export id changed during smoke: expected ${launched.exportId}, received ${attempt.id}.`);
      }
      if (attempt?.status === 'completed') return 'success';
      if (['failed', 'invalidated'].includes(attempt?.status)) return new Error(`Export ${attempt.status}: ${terminalDetail(attempt)}`);
      return 'continue';
    },
  );
  if (typeof completedExport.exportObjectKey !== 'string' || !completedExport.exportObjectKey.trim()) {
    throw new Error('Completed export has no exportObjectKey, so R2 export persistence is unproven.');
  }
  summary.exportStatus = completedExport.status;
  summary.exportObjectKey = completedExport.exportObjectKey;
  summary.exportStreamVideoUid = completedExport.streamVideoUid ?? null;

  stage = 'download-export';
  const mediaResponse = await rawRequest(
    `/api/projects/${encodeURIComponent(project.id)}/exports/vi/media?output=dubbed`,
    { method: 'GET' },
    [200],
  );
  const mediaContentType = mediaResponse.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaContentType !== 'video/mp4' && !mediaContentType.startsWith('video/')) {
    throw new Error(`Export media returned unexpected Content-Type ${JSON.stringify(mediaContentType)}.`);
  }
  const exportedMedia = await mediaResponse.arrayBuffer();
  assertMp4(exportedMedia);
  summary.mediaContentType = mediaContentType;
  summary.mediaBytes = exportedMedia.byteLength;

  stage = 'range-check';
  const rangeResponse = await rawRequest(
    `/api/projects/${encodeURIComponent(project.id)}/exports/vi/media?output=dubbed`,
    { method: 'GET', headers: { range: 'bytes=0-1023' } },
    [200, 206],
  );
  const rangeBytes = await rangeResponse.arrayBuffer();
  if (rangeResponse.status === 206) {
    const contentRange = rangeResponse.headers.get('content-range') ?? '';
    if (!/^bytes\s+0-\d+\/\d+$/i.test(contentRange)) {
      throw new Error(`Range response is missing a valid Content-Range header: ${JSON.stringify(contentRange)}.`);
    }
    if (rangeBytes.byteLength === 0 || rangeBytes.byteLength > 1_024) {
      throw new Error(`Range response returned unexpected byte count ${rangeBytes.byteLength}.`);
    }
  } else {
    assertMp4(rangeBytes);
  }
  summary.rangeStatus = rangeResponse.status;
  summary.rangeBytes = rangeBytes.byteLength;

  stage = 'complete';
  summary.status = 'passed';
  summary.completedAt = new Date().toISOString();
  await persistSummary();
  console.log(JSON.stringify(summary, null, 2));
}

try {
  await run();
} catch (error) {
  summary.status = 'failed';
  summary.failedStage = stage;
  summary.error = redact(error instanceof Error ? error.stack ?? error.message : String(error));
  summary.completedAt = new Date().toISOString();
  await persistSummary().catch(() => {});
  console.error(summary.error);
  process.exitCode = 1;
}
