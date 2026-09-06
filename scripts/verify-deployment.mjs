import { pathToFileURL } from 'node:url';

export const READINESS_URL = 'https://yupvox.qs3d.site/api/ready';
export const CURRENT_SCHEMA_REVISION = 11;

export async function probeDeployment(fetchImpl = fetch, url = READINESS_URL) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
    const body = await response.json();
    const ready = (
      response.ok
      && body?.ready === true
      && body?.service === 'dubflow'
      && body?.database === 'ready'
      && body?.schemaRevision === CURRENT_SCHEMA_REVISION
    );
    return { ok: ready, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function waitForDeployment({ attempts = 12, delayMs = 5000, fetchImpl = fetch } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await probeDeployment(fetchImpl);
    if (last.ok) return last;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`YupVox readiness check failed: ${JSON.stringify(last)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  waitForDeployment()
    .then((result) => console.log(`YupVox ready: ${READINESS_URL} (${result.status}) schema=${CURRENT_SCHEMA_REVISION}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
