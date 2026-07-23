import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '..');
const contractRoot = process.env.OSERO_API_CONTRACT_ROOT;
if (!contractRoot) {
  console.error('OSERO_API_CONTRACT_ROOT must point to the authoritative API checkout.');
  process.exit(1);
}

const contractFile = resolve(contractRoot, 'docs/client-migration/v1-contract.ts');
if (!existsSync(contractFile)) {
  console.error(`Authoritative API contract not found: ${contractFile}`);
  process.exit(1);
}

const temporaryRoot = resolve(workspaceRoot, 'tmp/api-v1-contract');
mkdirSync(temporaryRoot, { recursive: true });
const tsconfigPath = resolve(temporaryRoot, 'tsconfig.json');
writeFileSync(
  tsconfigPath,
  `${JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        baseUrl: '../..',
        composite: false,
        declaration: false,
        declarationMap: false,
        emitDeclarationOnly: false,
        noEmit: true,
        paths: {
          'osero-api-v1-contract': [contractFile],
        },
      },
      include: ['../../scripts/api-v1-contract.typecheck.ts'],
    },
    null,
    2,
  )}\n`,
);

const result = spawnSync('pnpm', ['exec', 'tsc', '--project', tsconfigPath], {
  cwd: workspaceRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
