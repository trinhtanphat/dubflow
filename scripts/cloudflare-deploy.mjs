import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function deploymentPlan() {
  return [
    ['npm', ['run', 'verify']],
    ['npx', ['wrangler', 'deploy', '--dry-run']],
    ['npx', ['wrangler', 'deploy']],
    ['npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote']],
    ['node', ['scripts/verify-deployment.mjs']],
  ];
}

function platformCommand(command) {
  if (process.platform !== 'win32') return command;
  if (command === 'npm') return 'npm.cmd';
  if (command === 'npx') return 'npx.cmd';
  return command;
}

export function runDeployment(plan = deploymentPlan()) {
  for (const [command, args] of plan) {
    const result = spawnSync(platformCommand(command), args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runDeployment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
