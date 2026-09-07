import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_ORIGIN = 'https://yupvox.qs3d.site';
const ZERO_COST_ASR_PROVIDER = 'workers-ai-whisper-large-v3-turbo';
const TERMINAL_JOB_STATUSES = new Set(['needs_review', 'completed', 'failed', 'cancelled']);
const TERMINAL_EXPORT_STATUSES = new Set(['completed', 'failed', 'invalidated']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function source(pathname) {
  return fs.readFileSync(new URL(`../${pathname}`, import.meta.url), 'utf8');
}

function requireSource(sourceText, needle, label) {
  if (!sourceText.includes(needle)) {
    throw new Error(`Zero-cost source admission failed: ${label} is missing ${needle}.`);
  }
}

export function assertCheckedOutZeroCostSource() {
  const asrRouter = source('worker/src/services/asr/router.ts');
  const translationRouter = source('worker/src/services/translation/router.ts');
  const exportPipeline = source('worker/src/workflows/zeroContainerExportPipeline.ts');

  requireSource(asrRouter, 'PAID_DEEPGRAM_ASR_ENABLED', 'services/asr/router.ts');
  requireSource(asrRouter, "provider: 'workers-ai-whisper-large-v3-turbo'", 'services/asr/router.ts');
  const deepgramGate = asrRouter.indexOf("trim().toLowerCase() !== 'true'");
  const deepgramProvider = asrRouter.indexOf('new DeepgramNova3AsrProvider');
  if (deepgramGate < 0 || deepgramProvider < 0 || deepgramGate > deepgramProvider) {
    throw new Error('Zero-cost source admission failed: Deepgram is not visibly guarded by explicit paid opt-in.');
  }

  requireSource(translationRouter, 'requested === undefined', 'services/translation/router.ts');
  const defaultMode = translationRouter.indexOf('requested === undefined');
  const workersMode = translationRouter.indexOf("'workers-ai'", defaultMode);
  const googleBranch = translationRouter.indexOf("mode === 'google'");
  if (defaultMode < 0 || workersMode < 0 || googleBranch < 0 || workersMode > googleBranch) {
    throw new Error('Zero-cost source admission failed: default translation is not visibly routed through Workers AI before Google mode.');
  }

  requireSource(exportPipeline, 'targetVoiceObjectKey', 'zeroContainerExportPipeline.ts');
  requireSource(exportPipeline, 'deps.voice.generate', 'zeroContainerExportPipeline.ts');
  const cacheIdentity = exportPipeline.indexOf('targetVoiceObjectKey');
  const exactCache = exportPipeline.indexOf("voiceStatus === 'completed'", cacheIdentity);
  const voiceGenerate = exportPipeline.indexOf('deps.voice.generate', exactCache);
  if (cacheIdentity < 0 || exactCache < 0 || voiceGenerate < 0 || exactCache > voiceGenerate) {
    throw new Error('Zero-cost source admission failed: exact client voice cache is not checked before server voice generation.');
  }
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
  if (body?.asr?.provider !== ZERO_COST_ASR_PROVIDER) {
    throw new Error(`Production ASR is not on the zero-cost Workers AI route: ${JSON.stringify(body?.asr ?? null)}`);
  }
}

async function waitForJob(fetchImpl, origin, projectId, jobId, { attempts = 240, delayMs = 4000 } = {}) {
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

async function uploadFixture(fetchImpl, origin, projectId, media) {
  const begun = await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'production-browser-piper-fixture.mp4', sizeBytes: media.byteLength, contentType: 'video/mp4' }),
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
}

function assertMp4(bytes, contentType) {
  if (!contentType.toLowerCase().includes('video/mp4')) {
    throw new Error(`Final export is not video/mp4: ${contentType || '<missing>'}`);
  }
  if (bytes.byteLength < 16) throw new Error(`Final MP4 is unexpectedly small: ${bytes.byteLength} bytes`);
  const marker = Buffer.from(bytes).subarray(4, 8).toString('ascii');
  if (marker !== 'ftyp') throw new Error(`Final export does not start with an MP4 ftyp box: ${marker}`);
}

function expectedVoiceObjectKey(projectId, segmentId, version) {
  return `projects/${projectId}/voices/vi/${segmentId}/${version}.pcm`;
}

async function fetchVietnameseVariants(fetchImpl, origin, projectId) {
  const result = await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}/translations/vi`);
  if (!Array.isArray(result.body?.segments)) {
    throw new Error(`Vietnamese translation variants returned an invalid contract: ${JSON.stringify(result.body)}`);
  }
  return result.body.segments;
}

async function assertExactVietnameseBrowserPcm(fetchImpl, origin, projectId) {
  const rows = await fetchVietnameseVariants(fetchImpl, origin, projectId);
  if (rows.length === 0) throw new Error('Unable to verify exact Vietnamese browser PCM cache: no translation variants exist.');
  for (const row of rows) {
    const translation = row?.translation;
    const segmentId = row?.segmentId;
    const version = translation?.version;
    const expectedKey = expectedVoiceObjectKey(projectId, segmentId, version);
    if (
      !segmentId
      || translation?.translationStatus !== 'completed'
      || !translation?.translatedText?.trim()
      || !Number.isInteger(version)
      || version < 1
      || translation?.voiceStatus !== 'completed'
      || translation?.dubbedObjectKey !== expectedKey
    ) {
      throw new Error(`Unable to verify exact Vietnamese browser PCM cache: ${JSON.stringify({
        segmentId,
        version,
        translationStatus: translation?.translationStatus ?? null,
        voiceStatus: translation?.voiceStatus ?? null,
        dubbedObjectKey: translation?.dubbedObjectKey ?? null,
        expectedKey,
      })}`);
    }
  }
  return rows;
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${pending.method} failed: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result ?? {});
    });
    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Chrome DevTools connection closed unexpectedly.'));
      this.pending.clear();
    });
  }

  static async connect(url) {
    if (typeof WebSocket === 'undefined') throw new Error('Node WebSocket support is required for the browser production fixture.');
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools.')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Unable to connect to Chrome DevTools.')); }, { once: true });
    });
    return new CdpClient(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text ?? 'unknown exception'}`);
    return result.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

async function waitForChromeTarget(port, attempts = 100, delayMs = 200) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`Chrome DevTools page target did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`);
}

async function launchBrowser(chromeBin) {
  if (!chromeBin || !fs.existsSync(chromeBin)) throw new Error(`CHROME_BIN is missing or invalid: ${chromeBin || '<missing>'}`);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubflow-browser-piper-'));
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  chrome.stderr.on('data', (chunk) => { stderr += String(chunk).slice(-4000); });
  const activePortPath = path.join(profileDir, 'DevToolsActivePort');
  let port = null;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited before DevTools became ready (${chrome.exitCode}): ${stderr}`);
    if (fs.existsSync(activePortPath)) {
      const [rawPort] = fs.readFileSync(activePortPath, 'utf8').trim().split(/\r?\n/);
      const parsed = Number(rawPort);
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
        break;
      }
    }
    await sleep(200);
  }
  if (!port) {
    chrome.kill('SIGKILL');
    fs.rmSync(profileDir, { recursive: true, force: true });
    throw new Error(`Chrome did not publish a remote-debugging-port: ${stderr}`);
  }

  const target = await waitForChromeTarget(port);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return {
    cdp,
    chrome,
    profileDir,
    async close() {
      cdp.close();
      if (chrome.exitCode === null) chrome.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => chrome.once('exit', resolve)),
        sleep(2000),
      ]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

async function waitForBrowser(cdp, predicateExpression, description, { attempts = 180, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await cdp.evaluate(predicateExpression);
    if (result) return result;
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for browser ${description}.`);
}

async function openStudioAndLaunchBrowserExport(browser, origin, projectId) {
  const url = `${origin}/projects/${encodeURIComponent(projectId)}`;
  await browser.cdp.send('Page.navigate', { url });
  await waitForBrowser(browser.cdp, `document.readyState === 'complete'`, 'document readiness');
  await waitForBrowser(
    browser.cdp,
    `Boolean(document.querySelector('details.phase4c-studio-dock'))`,
    'Studio language/export dock',
  );
  await browser.cdp.evaluate(`(() => {
    const dock = document.querySelector('details.phase4c-studio-dock');
    if (dock) dock.open = true;
    return Boolean(dock);
  })()`);

  const buttonState = await waitForBrowser(
    browser.cdp,
    `(() => {
      const button = document.querySelector('[data-testid="export-current-language"]');
      if (!button) return null;
      return { text: button.textContent?.trim() ?? '', disabled: Boolean(button.disabled) };
    })()`,
    'Export current language button',
    { attempts: 120, delayMs: 1000 },
  );
  if (!buttonState.text.includes('Export current language')) {
    throw new Error(`Unexpected production export button: ${JSON.stringify(buttonState)}`);
  }
  if (buttonState.disabled) {
    throw new Error(`Production browser Piper export button is disabled: ${JSON.stringify(buttonState)}`);
  }

  const clicked = await browser.cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid="export-current-language"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('Unable to click Export current language in production Studio.');
}

async function browserUiError(cdp) {
  return cdp.evaluate(`(() => {
    const error = document.querySelector('.batch-export__error');
    return error?.textContent?.trim() || '';
  })()`);
}

async function latestVietnameseExport(fetchImpl, origin, projectId) {
  const url = `${origin}/api/projects/${encodeURIComponent(projectId)}/exports/vi?output=dubbed`;
  const response = await fetchImpl(url);
  if (response.status === 404) return null;
  const body = await readJson(response);
  if (!response.ok) throw new Error(`GET ${url} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function waitForBrowserExport(fetchImpl, origin, projectId, cdp, { attempts = 360, delayMs = 3000 } = {}) {
  let launchVerified = false;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const uiError = await browserUiError(cdp);
    if (uiError) throw new Error(`Production browser Piper UI failed closed: ${uiError}`);

    last = await latestVietnameseExport(fetchImpl, origin, projectId);
    if (last && !launchVerified) {
      await assertExactVietnameseBrowserPcm(fetchImpl, origin, projectId);
      launchVerified = true;
    }
    if (last && TERMINAL_EXPORT_STATUSES.has(last.status)) {
      if (last.status !== 'completed') {
        throw new Error(`Browser Piper export ended ${last.status}: ${last.errorCode ?? 'UNKNOWN'} ${last.errorMessage ?? ''}`.trim());
      }
      return last;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  if (!last) throw new Error('Browser Piper export did not launch from Export current language.');
  throw new Error(`Browser Piper export did not complete: ${JSON.stringify(last)}`);
}

export async function runProductionBrowserPiperFixture({
  fetchImpl = fetch,
  origin = PRODUCTION_ORIGIN,
  fixturePath = process.env.PRODUCTION_MEDIA_FIXTURE_PATH,
  outputPath = process.env.PRODUCTION_MEDIA_OUTPUT_PATH,
  chromeBin = process.env.CHROME_BIN,
} = {}) {
  assertCheckedOutZeroCostSource();
  if (!fixturePath) throw new Error('PRODUCTION_MEDIA_FIXTURE_PATH is required.');
  const media = fs.readFileSync(fixturePath);
  if (media.byteLength === 0) throw new Error('Production browser Piper media fixture is empty.');

  const readiness = await request(fetchImpl, `${origin}/api/ready`);
  assertReady(readiness.body);
  console.log(`Production zero-cost ASR ${JSON.stringify(readiness.body.asr)}`);

  const title = `prod-browser-piper-${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await request(fetchImpl, `${origin}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, sourceLanguage: 'en', targetLanguage: 'vi' }),
  }, [201]);
  const projectId = created.body?.id;
  if (!projectId) throw new Error(`Project creation returned no id: ${JSON.stringify(created.body)}`);

  await uploadFixture(fetchImpl, origin, projectId, media);
  const processing = await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}/process`, {
    method: 'POST',
  }, [202]);
  const processJobId = processing.body?.jobId;
  if (!processJobId) throw new Error(`Process start returned no jobId: ${JSON.stringify(processing.body)}`);
  const processJob = await waitForJob(fetchImpl, origin, projectId, processJobId);
  if (processJob.status !== 'needs_review' && processJob.status !== 'completed') {
    throw new Error(`Dubbing job did not become review/export ready: ${JSON.stringify(processJob)}`);
  }

  const browser = await launchBrowser(chromeBin);
  let exportAttempt;
  try {
    await openStudioAndLaunchBrowserExport(browser, origin, projectId);
    exportAttempt = await waitForBrowserExport(fetchImpl, origin, projectId, browser.cdp);
  } finally {
    await browser.close();
  }

  const mediaResponse = await fetchImpl(`${origin}/api/projects/${encodeURIComponent(projectId)}/exports/vi/media?output=dubbed`, {
    headers: { accept: 'video/mp4' },
  });
  if (!mediaResponse.ok) {
    const body = await readJson(mediaResponse);
    throw new Error(`Final browser Piper media download failed (${mediaResponse.status}): ${JSON.stringify(body)}`);
  }
  const contentType = mediaResponse.headers.get('content-type') ?? '';
  const outputBytes = new Uint8Array(await mediaResponse.arrayBuffer());
  assertMp4(outputBytes, contentType);
  if (outputPath) fs.writeFileSync(outputPath, outputBytes);

  return {
    ok: true,
    origin,
    projectId,
    processJobId,
    exportId: exportAttempt?.id ?? null,
    sourceBytes: media.byteLength,
    outputBytes: outputBytes.byteLength,
    contentType,
    asrProvider: ZERO_COST_ASR_PROVIDER,
    voiceLane: 'browser-piper-exact-version-pcm',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runProductionBrowserPiperFixture()
    .then((result) => console.log(`Production browser Piper fixture PASS ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
