import { existsSync } from 'node:fs';

if (existsSync('.github/workflows')) {
  console.error('DubFlow policy violation: .github/workflows must not exist. Deploy with Wrangler only.');
  process.exit(1);
}

console.log('OK: no GitHub Actions workflows; Wrangler-only delivery policy preserved.');
