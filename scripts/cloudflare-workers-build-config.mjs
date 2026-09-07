import fs from 'node:fs';

export const PRODUCTION_CONFIG_PATH = '.wrangler-production.json';

export function prepareWorkersBuildConfig() {
  const source = JSON.parse(
    fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  );
  delete source.containers;
  delete source.durable_objects;
  delete source.exports;
  delete source.routes;
  fs.writeFileSync(
    new URL(`../${PRODUCTION_CONFIG_PATH}`, import.meta.url),
    `${JSON.stringify(source, null, 2)}\n`,
  );
}
