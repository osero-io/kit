import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '..');
const contractRoot = process.env.OSERO_API_CONTRACT_ROOT;
if (!contractRoot) {
  console.error('OSERO_API_CONTRACT_ROOT must point to the authoritative API checkout.');
  process.exit(1);
}
for (const name of ['enso-same-chain-quote.json', 'lifi-cross-chain-quote.json']) {
  const fixture = resolve(contractRoot, 'docs/client-migration/examples', name);
  if (!existsSync(fixture)) {
    console.error(`Authoritative contract fixture not found: ${fixture}`);
    process.exit(1);
  }
}

const forwarded = process.argv
  .slice(2)
  .filter((argument) => argument !== '--')
  .flatMap((argument) => (argument === '--json' ? ['--reporter=json'] : [argument]));
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    '--config',
    'packages/client/vitest.config.mts',
    '--run',
    'tests/api-v1-contract.test.ts',
    ...forwarded,
  ],
  {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
