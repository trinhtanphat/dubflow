import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function gatewayWorkersBuildDeploymentPlan() {
  return [
    ['npx', ['wrangler', 'deploy', '--config', 'wrangler.gateway.jsonc']],
  ];
}

export function runGatewayWorkersBuildDeployment(plan = gatewayWorkersBuildDeploymentPlan()) {
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
    runGatewayWorkersBuildDeployment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
