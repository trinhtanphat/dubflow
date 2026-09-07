import { readFile, stat, writeFile } from 'node:fs/promises';

const origin = process.env.PROD_ORIGIN ?? 'https://yupvox.qs3d.site';
const sourcePath = process.argv[2];
const outputPath = process.argv[3];

if (!sourcePath || !outputPath) {
  throw new Error('Usage: node scripts/prod-h264-smoke.mjs <source.mp4> <output.mp4>');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

async function request(path, init = {}, expected = [200]) {
  const response = await fetch(`${origin}${path}`, {
    redirect: 'follow',
    ...init,
  });
  const body = await parseResponse(response);
  if (!expected.includes(response.status)) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return { response, body };
}

async function jsonRequest(path, method, body, expected) {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, expected);
}

async function pollJob(projectId, jobId, desired, label) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const { body } = await request(`/api/projects/${projectId}/jobs/${jobId}`, {
      headers: { accept: 'application/json' },
    });
    if (body?.status === desired) return body;
    if (['failed', 'cancelled'].includes(body?.status)) {
      throw new Error(`${label} ${body.status}: ${body.errorCode ?? ''} ${body.errorMessage ?? ''}`.trim());
    }
    await sleep(2000);
  }
  throw new Error(`${label} did not reach ${desired}`);
}

const ready = await request('/api/ready', { headers: { accept: 'application/json' } });
if (
  ready.body?.ready !== true
  || ready.body?.database !== 'ready'
  || ready.body?.schemaRevision !== 14
  || ready.body?.media?.r2 !== 'ready'
  || ready.body?.media?.remux !== 'ready'
) {
  throw new Error(`Production readiness is stale: ${JSON.stringify(ready.body)}`);
}

const title = `PROD H264 SMOKE ${new Date().toISOString()}`;
const created = await jsonRequest('/api/projects', 'POST', {
  title,
  sourceLanguage: 'en',
  targetLanguage: 'vi',
}, [201]);
const projectId = created.body?.id;
if (!projectId) throw new Error(`Project creation returned no id: ${JSON.stringify(created.body)}`);

const sourceBytes = await readFile(sourcePath);
const sourceInfo = await stat(sourcePath);
const begun = await jsonRequest(`/api/projects/${projectId}/uploads`, 'POST', {
  filename: 'prod-h264-smoke.mp4',
  sizeBytes: sourceInfo.size,
  contentType: 'video/mp4',
}, [201]);
const uploadId = begun.body?.uploadId;
const objectKey = begun.body?.objectKey;
if (!uploadId || !objectKey) throw new Error(`Upload begin returned incomplete data: ${JSON.stringify(begun.body)}`);

const part = await request(
  `/api/projects/${projectId}/uploads/${encodeURIComponent(uploadId)}/parts/1?objectKey=${encodeURIComponent(objectKey)}`,
  {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4', accept: 'application/json' },
    body: sourceBytes,
  },
  [200],
);
if (!part.body?.etag) throw new Error(`Upload part returned no etag: ${JSON.stringify(part.body)}`);

const completedUpload = await jsonRequest(
  `/api/projects/${projectId}/uploads/${encodeURIComponent(uploadId)}/complete`,
  'POST',
  { objectKey, parts: [{ partNumber: 1, etag: part.body.etag }] },
  [200],
);
if (completedUpload.body?.objectKey !== objectKey) {
  throw new Error(`Upload complete object mismatch: ${JSON.stringify(completedUpload.body)}`);
}

const startedProcess = await jsonRequest(`/api/projects/${projectId}/process`, 'POST', undefined, [202]);
const processJobId = startedProcess.body?.jobId;
if (!processJobId) throw new Error(`Process start returned no job id: ${JSON.stringify(startedProcess.body)}`);
const processJob = await pollJob(projectId, processJobId, 'needs_review', 'dubbing job');

const projectAfterDubbing = await request(`/api/projects/${projectId}`, { headers: { accept: 'application/json' } });
if (projectAfterDubbing.body?.status !== 'needs_review') {
  throw new Error(`Project did not reach needs_review: ${JSON.stringify(projectAfterDubbing.body)}`);
}
if (!(Number(projectAfterDubbing.body?.durationMs) > 0)) {
  throw new Error(`Project duration was not persisted: ${JSON.stringify(projectAfterDubbing.body)}`);
}

const startedExport = await jsonRequest(`/api/projects/${projectId}/export`, 'POST', undefined, [202]);
const exportJobId = startedExport.body?.jobId;
if (!exportJobId) throw new Error(`Export start returned no job id: ${JSON.stringify(startedExport.body)}`);
const exportJob = await pollJob(projectId, exportJobId, 'completed', 'export job');

const latestExport = await request(`/api/projects/${projectId}/exports/vi?output=dubbed`, {
  headers: { accept: 'application/json' },
});
if (latestExport.body?.status !== 'completed' || !latestExport.body?.exportObjectKey) {
  throw new Error(`Latest export is not completed in R2: ${JSON.stringify(latestExport.body)}`);
}

const mediaResponse = await fetch(`${origin}/api/projects/${projectId}/export/media`, { redirect: 'follow' });
if (!mediaResponse.ok) {
  throw new Error(`Export media download -> ${mediaResponse.status}: ${await mediaResponse.text()}`);
}
const outputBytes = Buffer.from(await mediaResponse.arrayBuffer());
if (outputBytes.length === 0) throw new Error('Export media body is empty.');
await writeFile(outputPath, outputBytes);

const report = {
  origin,
  projectId,
  projectTitle: title,
  sourceObjectKey: objectKey,
  exportObjectKey: latestExport.body.exportObjectKey,
  sourceBytes: sourceBytes.length,
  outputBytes: outputBytes.length,
  processJob: {
    id: processJob.id,
    status: processJob.status,
    progress: processJob.progress,
  },
  exportJob: {
    id: exportJob.id,
    status: exportJob.status,
    progress: exportJob.progress,
  },
  readiness: {
    schemaRevision: ready.body.schemaRevision,
    database: ready.body.database,
    media: ready.body.media,
  },
};
console.log(`SMOKE_RESULT=${JSON.stringify(report)}`);
