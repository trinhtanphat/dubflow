import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_ORIGIN = 'https://yupvox.qs3d.site';

const BROWSER_LOCAL_ASR = {
  provider: 'browser-whisper',
  model: 'onnx-community/whisper-tiny.en',
  revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
};
const BROWSER_LOCAL_TRANSLATION = {
  provider: 'browser-opus-mt',
  model: 'Xenova/opus-mt-en-vi',
  revision: '3f5f449333cbc7ecaa9eec16ee9e37682f036b8e',
};
const TERMINAL_EXPORT_STATUSES = new Set(['completed', 'failed', 'invalidated']);
const LOCAL_ACTION_LABEL = 'Process locally (zero-cost)';

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

function assertMp4(bytes, contentType) {
  if (!contentType.toLowerCase().includes('video/mp4')) {
    throw new Error(`Final export is not video/mp4: ${contentType || '<missing>'}`);
  }
  if (bytes.byteLength < 16) throw new Error(`Final MP4 is unexpectedly small: ${bytes.byteLength} bytes`);
  const marker = Buffer.from(bytes).subarray(4, 8).toString('ascii');
  if (marker !== 'ftyp') throw new Error(`Final export does not start with an MP4 ftyp box: ${marker}`);
}

async function waitForExport(fetchImpl, origin, projectId, { attempts = 360, delayMs = 3000 } = {}) {
  let last = null;
  const url = `${origin}/api/projects/${encodeURIComponent(projectId)}/exports/vi?output=dubbed`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(url);
    if (response.status !== 404) {
      const body = await readJson(response);
      if (!response.ok) throw new Error(`GET ${url} failed (${response.status}): ${JSON.stringify(body)}`);
      last = body;
      if (last && TERMINAL_EXPORT_STATUSES.has(last.status)) {
        if (last.status !== 'completed') {
          throw new Error(`Export ${last.id ?? '<unknown>'} ended ${last.status}: ${last.errorCode ?? 'UNKNOWN'} ${last.errorMessage ?? ''}`.trim());
        }
        return last;
      }
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`Production browser-local export did not complete: ${JSON.stringify(last)}`);
}

async function uploadFixture(fetchImpl, origin, projectId, media) {
  const begun = await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'production-browser-local-fixture.mp4',
      sizeBytes: media.byteLength,
      contentType: 'video/mp4',
    }),
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

function assertBrowserLocalRows(projectId, rows) {
  if (rows.length === 0) throw new Error('Browser-local processing returned no Vietnamese translation variants.');
  const speakerId = `browser-local:${projectId}:speaker-1`;
  for (const row of rows) {
    const translation = row?.translation;
    if (
      !row?.segmentId
      || row?.speakerId !== speakerId
      || !row?.sourceText?.trim()
      || translation?.translationEngine !== BROWSER_LOCAL_TRANSLATION.provider
      || translation?.translationStatus !== 'completed'
      || !translation?.translatedText?.trim()
      || !Number.isInteger(translation?.version)
      || translation.version < 1
    ) {
      throw new Error(`Production browser-local Vietnamese variant is not canonical: ${JSON.stringify(row)}`);
    }
  }
}

async function assertBrowserLocalState(fetchImpl, origin, projectId) {
  const result = await request(fetchImpl, `${origin}/api/projects/${encodeURIComponent(projectId)}`);
  const state = result.body?.clientInferenceState;
  if (
    !state
    || state.asr?.provider !== BROWSER_LOCAL_ASR.provider
    || state.asr?.model !== BROWSER_LOCAL_ASR.model
    || state.asr?.revision !== BROWSER_LOCAL_ASR.revision
    || state.translation?.provider !== BROWSER_LOCAL_TRANSLATION.provider
    || state.translation?.model !== BROWSER_LOCAL_TRANSLATION.model
    || state.translation?.revision !== BROWSER_LOCAL_TRANSLATION.revision
    || !Number.isInteger(state.sourceGeneration)
    || state.sourceGeneration < 1
    || !state.sourceObjectKey?.trim()
  ) {
    throw new Error(`Production browser-local inference provenance is not exact: ${JSON.stringify(state ?? null)}`);
  }
  return state;
}

async function assertExactBrowserPcm(fetchImpl, origin, projectId) {
  const rows = await fetchVietnameseVariants(fetchImpl, origin, projectId);
  assertBrowserLocalRows(projectId, rows);
  for (const row of rows) {
    const translation = row.translation;
    const expectedKey = expectedVoiceObjectKey(projectId, row.segmentId, translation.version);
    if (translation.voiceStatus !== 'completed' || translation.dubbedObjectKey !== expectedKey) {
      throw new Error(`Browser Piper exact-version PCM was not durable before export launch: ${JSON.stringify({
        segmentId: row.segmentId,
        version: translation.version,
        voiceStatus: translation.voiceStatus ?? null,
        dubbedObjectKey: translation.dubbedObjectKey ?? null,
        expectedKey,
      })}`);
    }
  }
  return rows;
}

function resolveBrowserExecutable(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const resolved = execFileSync('which', [command], { encoding: 'utf8' }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {
      // Try the next known browser binary.
    }
  }
  throw new Error('No production browser executable is available. Set PRODUCTION_BROWSER_EXECUTABLE to a Chrome/Chromium binary.');
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`CDP ${pending.method} failed: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (!message.method) return;
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Chrome DevTools connection closed unexpectedly.'));
      this.pending.clear();
    });
  }

  static async connect(url) {
    if (typeof WebSocket === 'undefined') throw new Error('Node 22 WebSocket support is required for the production browser fixture.');
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools.')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Unable to connect to Chrome DevTools.')); }, { once: true });
    });
    return new CdpClient(ws);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
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
    if (result.exceptionDetails) {
      throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text ?? 'unknown exception'}`);
    }
    return result.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

async function waitForPageTarget(port, attempts = 100, delayMs = 200) {
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

async function launchBrowser(executable) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubflow-prod-browser-local-'));
  const browser = spawn(executable, [
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
  browser.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8000); });
  const activePortPath = path.join(profileDir, 'DevToolsActivePort');
  let port = null;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    if (browser.exitCode !== null) throw new Error(`Chromium exited before DevTools became ready (${browser.exitCode}): ${stderr}`);
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
    browser.kill('SIGKILL');
    fs.rmSync(profileDir, { recursive: true, force: true });
    throw new Error(`Chromium did not publish its remote debugging port: ${stderr}`);
  }

  const target = await waitForPageTarget(port);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable').catch(() => ({}));

  const diagnostics = [];
  const record = (kind, text) => {
    if (!text) return;
    diagnostics.push(`${kind}: ${String(text).slice(0, 800)}`);
    if (diagnostics.length > 20) diagnostics.shift();
  };
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => record('pageerror', exceptionDetails?.text));
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => record(`console.${type}`, (args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')));
  cdp.on('Log.entryAdded', ({ entry }) => record(`log.${entry?.level ?? 'unknown'}`, entry?.text));

  return {
    cdp,
    diagnostics,
    browser,
    profileDir,
    async close() {
      cdp.close();
      if (browser.exitCode === null) browser.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), sleep(2000)]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

async function waitForBrowserValue(cdp, expression, description, { attempts = 180, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await cdp.evaluate(expression);
    if (value) return value;
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for production browser ${description}.`);
}

function createJsonResponseObserver(cdp, { method, url, label, timeoutMs = 15 * 60_000 }) {
  const requests = new Map();
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const offRequest = cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (request?.method === method && request?.url === url) requests.set(requestId, { response: null });
  });
  const offResponse = cdp.on('Network.responseReceived', ({ requestId, response }) => {
    const tracked = requests.get(requestId);
    if (tracked) tracked.response = response;
  });
  const offFailed = cdp.on('Network.loadingFailed', ({ requestId, errorText }) => {
    if (!requests.has(requestId) || settled) return;
    settled = true;
    cleanup();
    rejectPromise(new Error(`${label} request failed: ${errorText ?? 'unknown network failure'}`));
  });
  const offFinished = cdp.on('Network.loadingFinished', async ({ requestId }) => {
    const tracked = requests.get(requestId);
    if (!tracked || settled) return;
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId });
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      const parsed = text ? JSON.parse(text) : null;
      const status = tracked.response?.status ?? 0;
      if (status < 200 || status >= 300) {
        throw new Error(`${label} failed (${status}): ${JSON.stringify(parsed)}`);
      }
      settled = true;
      cleanup();
      resolvePromise(parsed);
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    }
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(new Error(`Timed out waiting for ${label} ${method} ${url}.`));
  }, timeoutMs);

  function cleanup() {
    clearTimeout(timer);
    offRequest();
    offResponse();
    offFailed();
    offFinished();
  }

  return { promise, cancel: cleanup };
}

async function currentUiError(cdp) {
  return cdp.evaluate(`(() => {
    const node = document.querySelector('.target-languages__error, .batch-export__error, [role="alert"]');
    return node?.textContent?.trim() || '';
  })()`);
}

async function waitForObservedResponse(browser, observer, description) {
  let settled = false;
  const observed = observer.promise.finally(() => { settled = true; });
  const failClosed = (async () => {
    for (let attempt = 1; attempt <= 450; attempt += 1) {
      if (settled) return new Promise(() => {});
      const uiError = await currentUiError(browser.cdp);
      if (uiError) throw new Error(`${description} failed closed in Studio: ${uiError}`);
      await sleep(2000);
    }
    throw new Error(`${description} was not observed; diagnostics=${JSON.stringify(browser.diagnostics)}`);
  })();
  return Promise.race([observed, failClosed]);
}

async function runLocalFlowThroughStudio(browser, origin, projectId) {
  const pageUrl = `${origin}/projects/${encodeURIComponent(projectId)}`;
  await browser.cdp.send('Page.navigate', { url: pageUrl });
  await waitForBrowserValue(browser.cdp, `document.readyState === 'complete'`, 'document readiness');
  await waitForBrowserValue(
    browser.cdp,
    `Boolean([...document.querySelectorAll('details')].find((node) => node.querySelector('summary')?.textContent?.includes('Ngôn ngữ & export')))`,
    'language/export dock',
  );
  await browser.cdp.evaluate(`(() => {
    const dock = [...document.querySelectorAll('details')].find((node) => node.querySelector('summary')?.textContent?.includes('Ngôn ngữ & export'));
    if (dock) dock.open = true;
    return Boolean(dock);
  })()`);

  const buttonState = await waitForBrowserValue(
    browser.cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === '${LOCAL_ACTION_LABEL}');
      if (!button || button.disabled) return null;
      return { text: button.textContent?.trim() ?? '', disabled: false };
    })()`,
    'enabled Process locally (zero-cost) control',
    { attempts: 180, delayMs: 1000 },
  );
  if (buttonState.text !== LOCAL_ACTION_LABEL) {
    throw new Error(`Unexpected production local inference control: ${JSON.stringify(buttonState)}`);
  }

  const commitUrl = `${origin}/api/projects/${encodeURIComponent(projectId)}/client-inference/vi`;
  const exportUrl = `${origin}/api/projects/${encodeURIComponent(projectId)}/exports/vi`;
  const commitObserver = createJsonResponseObserver(browser.cdp, {
    method: 'PUT',
    url: commitUrl,
    label: 'browser-local client-inference commit',
  });
  const exportObserver = createJsonResponseObserver(browser.cdp, {
    method: 'POST',
    url: exportUrl,
    label: 'browser-local dubbed export launch',
  });

  try {
    const clicked = await browser.cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === '${LOCAL_ACTION_LABEL}');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error('Unable to trigger Process locally (zero-cost) through deployed Studio.');

    const commitResult = await waitForObservedResponse(browser, commitObserver, 'Browser-local inference');
    if (!commitResult?.projectId || commitResult.projectId !== projectId) {
      throw new Error(`Browser-local client-inference commit returned invalid identity: ${JSON.stringify(commitResult)}`);
    }

    const launchResult = await waitForObservedResponse(browser, exportObserver, 'Browser-local Piper/export');
    if (!launchResult?.exportId || !launchResult?.jobId) {
      throw new Error(`Production browser-local export response returned no exportId/jobId: ${JSON.stringify(launchResult)}`);
    }
    return { commitResult, launchResult };
  } finally {
    commitObserver.cancel();
    exportObserver.cancel();
  }
}

async function proveReloadDurability(browser, projectId, exportId) {
  await browser.cdp.send('Page.reload', { ignoreCache: false });
  await waitForBrowserValue(browser.cdp, `document.readyState === 'complete'`, 'reload readiness');
  const durable = await browser.cdp.evaluate(`(async () => {
    const response = await fetch('/api/projects/${encodeURIComponent(projectId)}/exports/vi?output=dubbed', { credentials: 'same-origin' });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  })()`);
  if (durable?.status !== 200 || durable?.body?.id !== exportId) {
    throw new Error(`Production Studio reload did not preserve export identity ${exportId}: ${JSON.stringify(durable)}`);
  }
}

export async function runProductionBrowserPiperFixture({
  fetchImpl = fetch,
  origin = PRODUCTION_ORIGIN,
  fixturePath = process.env.PRODUCTION_MEDIA_FIXTURE_PATH,
  outputPath = process.env.PRODUCTION_MEDIA_OUTPUT_PATH,
  browserExecutable = process.env.PRODUCTION_BROWSER_EXECUTABLE,
  zeroChargeVerified = process.env.PRODUCTION_ZERO_CHARGE_VERIFIED,
} = {}) {
  if (String(zeroChargeVerified ?? '').trim().toLowerCase() !== 'true') {
    throw new Error('ZERO_CHARGE_RUNTIME_UNVERIFIED: refuse production browser fixture before any production request.');
  }
  if (!fixturePath) throw new Error('PRODUCTION_MEDIA_FIXTURE_PATH is required.');
  if (!outputPath) throw new Error('PRODUCTION_MEDIA_OUTPUT_PATH is required.');
  const media = fs.readFileSync(fixturePath);
  if (media.byteLength === 0) throw new Error('Production browser-local fixture is empty.');

  const readiness = await request(fetchImpl, `${origin}/api/ready`);
  assertReady(readiness.body);

  const title = `prod-browser-local-${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await request(fetchImpl, `${origin}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, sourceLanguage: 'en', targetLanguage: 'vi' }),
  }, [201]);
  const projectId = created.body?.id;
  if (!projectId) throw new Error(`Project creation returned no id: ${JSON.stringify(created.body)}`);

  await uploadFixture(fetchImpl, origin, projectId, media);

  const executable = resolveBrowserExecutable(browserExecutable);
  const browser = await launchBrowser(executable);
  let launchResult;
  let commitResult;
  let inferenceState;
  try {
    const flow = await runLocalFlowThroughStudio(browser, origin, projectId);
    launchResult = flow.launchResult;
    commitResult = flow.commitResult;
    inferenceState = await assertBrowserLocalState(fetchImpl, origin, projectId);
    await assertExactBrowserPcm(fetchImpl, origin, projectId);
    await proveReloadDurability(browser, projectId, launchResult.exportId);
  } catch (error) {
    const detail = browser.diagnostics.length ? `; browser diagnostics=${JSON.stringify(browser.diagnostics)}` : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  } finally {
    await browser.close();
  }

  const exportAttempt = await waitForExport(fetchImpl, origin, projectId);
  if (exportAttempt.id !== launchResult.exportId) {
    throw new Error(`Completed export identity drifted after reload: launched=${launchResult.exportId}, completed=${exportAttempt.id ?? '<missing>'}`);
  }

  const mediaResponse = await fetchImpl(`${origin}/api/projects/${encodeURIComponent(projectId)}/exports/vi/media?output=dubbed`, {
    headers: { accept: 'video/mp4' },
  });
  if (!mediaResponse.ok) {
    const body = await readJson(mediaResponse);
    throw new Error(`Final browser-local media download failed (${mediaResponse.status}): ${JSON.stringify(body)}`);
  }
  const contentType = mediaResponse.headers.get('content-type') ?? '';
  const outputBytes = new Uint8Array(await mediaResponse.arrayBuffer());
  assertMp4(outputBytes, contentType);
  fs.writeFileSync(outputPath, outputBytes);

  return {
    ok: true,
    origin,
    projectId,
    sourceGeneration: commitResult.sourceGeneration ?? inferenceState.sourceGeneration,
    exportId: launchResult.exportId,
    exportJobId: launchResult.jobId,
    sourceBytes: media.byteLength,
    outputBytes: outputBytes.byteLength,
    contentType,
    asrProvider: BROWSER_LOCAL_ASR.provider,
    translationProvider: BROWSER_LOCAL_TRANSLATION.provider,
    voiceLane: 'browser-piper-exact-version-pcm',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runProductionBrowserPiperFixture()
    .then((result) => console.log(`Production browser-local fixture PASS ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
