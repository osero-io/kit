import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../packages/client/', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const consumerViemVersion = process.env['OSERO_CONSUMER_VIEM_VERSION'] ?? '2.28.0';

function run(args, cwd, environment = {}) {
  const result = spawnSync(pnpm, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      [`pnpm ${args.join(' ')} failed`, result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
  }
  return result.stdout.trim();
}

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      [`node ${args.join(' ')} failed`, result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'osero-client-package-'));
try {
  const staleFixture = join(packageRoot, 'dist/lib/actions/__stale_release_fixture.js');
  await mkdir(join(packageRoot, 'dist/lib/actions'), { recursive: true });
  await writeFile(staleFixture, 'throw new Error("stale output leaked");\n');

  runNode([join(workspaceRoot, 'scripts/clean-client-output.mjs')], workspaceRoot);
  run(['nx', 'build', '@osero/client', '--skipNxCache'], workspaceRoot);
  runNode([join(workspaceRoot, 'scripts/check-client-api.mjs')], workspaceRoot);

  const packOutput = run(['pack', '--json', '--pack-destination', temporaryRoot], packageRoot);
  const metadata = JSON.parse(packOutput.slice(packOutput.indexOf('{')));
  const packedPaths = new Set(metadata.files.map((file) => file.path));
  const requiredPaths = [
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/lib/actions/index.js',
    'dist/lib/actions/index.d.ts',
    'dist/api.js',
    'dist/contracts.js',
    'dist/viem.js',
    'dist/eip5792.js',
    'dist/ethers.js',
    'dist/privy.js',
    'src/index.ts',
    'src/lib/actions/index.ts',
    'src/api.ts',
    'src/contracts.ts',
    'src/viem.ts',
    'src/eip5792.ts',
    'src/ethers.ts',
    'src/privy.ts',
  ];
  for (const path of requiredPaths) {
    if (!packedPaths.has(path)) throw new Error(`Packed client is missing required file ${path}`);
  }
  const forbidden = metadata.files
    .map((file) => file.path)
    .filter(
      (path) =>
        /(?:^|\/)(?:__stale_release_fixture|depositSUsds|_testing)(?:\.|$)/.test(path) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
        path.endsWith('.tsbuildinfo'),
    );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden files leaked into the tarball:\n${forbidden.join('\n')}`);
  }
  const unexpected = metadata.files
    .map((file) => file.path)
    .filter(
      (path) =>
        !['LICENSE', 'README.md', 'CHANGELOG.md', 'package.json'].includes(path) &&
        !/^dist\/.+\.(?:js|d\.ts|d\.ts\.map)$/.test(path) &&
        !/^src\/.+\.ts$/.test(path),
    );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected files appeared in the tarball:\n${unexpected.join('\n')}`);
  }

  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const publicSubpaths = Object.keys(manifest.exports).toSorted();
  const expectedSubpaths = [
    '.',
    './actions',
    './api',
    './contracts',
    './eip5792',
    './ethers',
    './package.json',
    './privy',
    './viem',
  ].toSorted();
  if (JSON.stringify(publicSubpaths) !== JSON.stringify(expectedSubpaths)) {
    throw new Error(`Unexpected public export map: ${JSON.stringify(publicSubpaths)}`);
  }
  if (
    manifest.main !== manifest.exports['.'].import ||
    manifest.module !== manifest.exports['.'].import ||
    manifest.types !== manifest.exports['.'].types
  ) {
    throw new Error('Legacy main/module/types fields must match the root export map');
  }
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === './package.json') continue;
    if (target.import !== target.default) {
      throw new Error(`${subpath} import and default targets must resolve to the same ESM file`);
    }
    for (const condition of ['osero-sdk', 'types', 'import', 'default']) {
      const path = target[condition].replace(/^\.\//, '');
      if (!packedPaths.has(path)) {
        throw new Error(`${subpath} ${condition} target ${path} is absent from the tarball`);
      }
    }
  }

  const consumerRoot = join(temporaryRoot, 'consumer');
  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'osero-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@osero/client': `file:${metadata.filename}`,
          viem: consumerViemVersion,
        },
        devDependencies: { typescript: '5.9.3' },
      },
      null,
      2,
    )}\n`,
  );
  run(
    ['install', '--prefer-offline', '--ignore-scripts', '--config.auto-install-peers=false'],
    consumerRoot,
  );

  await writeFile(
    join(consumerRoot, 'runtime-minimal.mjs'),
    `const root = await import('@osero/client');
await import('@osero/client/actions');
await import('@osero/client/api');
await import('@osero/client/contracts');
await import('@osero/client/viem');
await import('@osero/client/eip5792');
if (typeof root.OseroClient !== 'function') throw new Error('root runtime export missing');
for (const subpath of ['ethers', 'privy']) {
  const peer = subpath === 'ethers' ? 'ethers' : '@privy-io/node';
  try {
    await import('@osero/client/' + subpath);
    throw new Error(subpath + ' unexpectedly loaded without its optional peer');
  } catch (error) {
    if (String(error).includes('unexpectedly loaded')) throw error;
    if (!String(error).includes(peer)) throw error;
  }
}
`,
  );
  runNode(['runtime-minimal.mjs'], consumerRoot);

  await writeFile(
    join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          // viem's supported floor carries an old webauthn-p256 declaration
          // that newer TypeScript rejects internally. The SDK declaration
          // snapshot is checked separately before this consumer compile.
          skipLibCheck: true,
        },
        include: ['consumer.ts', 'removed.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    `import { OseroClient, parseSlippage, tokenAmount, type ExecutionPlanHandler } from '@osero/client';
import { prepareSwap, simulateExecutionPlan } from '@osero/client/actions';
import { OseroApiClient } from '@osero/client/api';
import { erc20Abi, PSM_ADDRESSES } from '@osero/client/contracts';
import { sendWith } from '@osero/client/viem';
import { sendWith as sendWithEip5792, supportsAtomicBatch } from '@osero/client/eip5792';
void [OseroClient, parseSlippage, tokenAmount, prepareSwap, simulateExecutionPlan, OseroApiClient, erc20Abi, PSM_ADDRESSES, sendWith, sendWithEip5792, supportsAtomicBatch];
const handler: ExecutionPlanHandler | undefined = undefined;
void handler;
`,
  );
  await writeFile(
    join(consumerRoot, 'removed.ts'),
    `// @ts-expect-error internal configuration is not a root export
import { resolveConfig } from '@osero/client';
// @ts-expect-error internal plan flattening is not a root export
import { flattenExecutionPlan } from '@osero/client';
// @ts-expect-error hosted API is isolated to the api subpath
import { OseroApiClient } from '@osero/client';
// @ts-expect-error legacy pair-specific actions were removed at the v1 cutover
import { mintUsds } from '@osero/client/actions';
void [resolveConfig, flattenExecutionPlan, OseroApiClient, mintUsds];
`,
  );
  run(['exec', 'tsc', '--project', 'tsconfig.json'], consumerRoot);

  run(
    [
      'add',
      '--save-exact',
      '--prefer-offline',
      '--ignore-scripts',
      '--config.auto-install-peers=false',
      'ethers@6.16.0',
      '@privy-io/node@0.19.0',
    ],
    consumerRoot,
  );
  await writeFile(
    join(consumerRoot, 'runtime-all.mjs'),
    `await Promise.all([
  import('@osero/client'),
  import('@osero/client/actions'),
  import('@osero/client/api'),
  import('@osero/client/contracts'),
  import('@osero/client/viem'),
  import('@osero/client/eip5792'),
  import('@osero/client/ethers'),
  import('@osero/client/privy'),
]);
`,
  );
  runNode(['runtime-all.mjs'], consumerRoot);

  console.log(
    `Validated ${metadata.files.length} packed files, every public subpath, optional-peer isolation, and TypeScript 5.9 consumer resolution`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
