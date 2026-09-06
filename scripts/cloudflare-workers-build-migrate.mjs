import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function shouldRunWorkersBuildMigrations(env = process.env) {
  return env.WORKERS_CI === '1' && env.WORKERS_CI_BRANCH === 'main';
}

export function workersBuildMigrationPlan() {
  return [
    ['npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote']],
  ];
}

function platformCommand(command) {
  if (process.platform !== 'win32') return command;
  if (command === 'npx') return 'npx.cmd';
  return command;
}

export function runWorkersBuildMigrations(
  env = process.env,
  plan = workersBuildMigrationPlan(),
) {
  if (!shouldRunWorkersBuildMigrations(env)) return false;

  for (const [command, args] of plan) {
    const result = spawnSync(platformCommand(command), args, {
      stdio: 'inherit',
      env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }
  }

  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runWorkersBuildMigrations();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
