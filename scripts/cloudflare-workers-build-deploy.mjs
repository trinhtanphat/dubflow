import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  PRODUCTION_CONFIG_PATH,
  prepareWorkersBuildConfig,
} from './cloudflare-workers-build-config.mjs';

export {
  PRODUCTION_CONFIG_PATH,
  prepareWorkersBuildConfig,
} from './cloudflare-workers-build-config.mjs';

export function workersBuildDeploymentPlan() {
  return [
    ['npx', ['wrangler', 'deploy', '--config', PRODUCTION_CONFIG_PATH]],
    ['npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', PRODUCTION_CONFIG_PATH]],
    ['node', ['scripts/verify-deployment.mjs']],
  ];
}

export function runWorkersBuildDeployment(plan = workersBuildDeploymentPlan()) {
  prepareWorkersBuildConfig();
  for (const [command, args] of plan) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runWorkersBuildDeployment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
