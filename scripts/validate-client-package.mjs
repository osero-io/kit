import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../packages/client/', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
// The consumer installs every peer at its supported floor, so the declared
// ranges are tested at their lower bound rather than at whatever is newest.
const consumerViemVersion = process.env['OSERO_CONSUMER_VIEM_VERSION'] ?? '2.28.0';
const consumerEthersVersion = process.env['OSERO_CONSUMER_ETHERS_VERSION'] ?? '6.14.0';
const consumerPrivyVersion = process.env['OSERO_CONSUMER_PRIVY_VERSION'] ?? '0.19.0';

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
  run(['turbo', 'run', 'build', '--filter=@osero/client', '--force'], workspaceRoot);
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
        include: ['consumer.ts', 'additions.ts', 'removed.ts'],
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
    join(consumerRoot, 'additions.ts'),
    `import {
  deserializeExecutionResumeState,
  executionResumeStateFromError,
  listSwapRoutes,
  serializeExecutionResumeState,
  type CompletedExecutionStep,
  type ExecutionFailureContext,
  type ExecutionPlan,
  type ExecutionResumeState,
  type ExecutorCapabilities,
  type OseroError,
  type Result,
  type SupportedSwapRoute,
} from '@osero/client';
import type { PlanSimulation, PrepareSwapRequest, SimulateExecutionPlanOptions } from '@osero/client/actions';
import type { OseroApiClient, OseroApiTransferStatusRequest } from '@osero/client/api';

// Types a consumer wrote against 1.0 must still compile: every field added since is optional.
const completed: CompletedExecutionStep = {
  planId: 'plan-x',
  stepId: 'swap',
  stepIndex: 0,
  operation: 'SWAP_EXACT_IN',
  hash: '0x00',
};
const failure: ExecutionFailureContext = {
  planId: 'plan-x',
  stepId: 'swap',
  stepIndex: 0,
  operation: 'SWAP_EXACT_IN',
  stage: 'confirmation',
  completed: [completed],
};
const capabilities: ExecutorCapabilities = {
  name: 'custom',
  sequentialTransactions: true,
  atomicBatch: false,
  permitAuthorization: false,
  sponsoredTransactions: false,
  chainSwitching: 'none',
  simulation: 'none',
};
const feeData: PlanSimulation['feeData'] = { gasPrice: 1n, source: 'rpc' };
declare const plan: ExecutionPlan;
declare const error: OseroError;
declare const state: ExecutionResumeState;
declare const api: OseroApiClient;
declare const statusRequest: OseroApiTransferStatusRequest;
const routes: readonly SupportedSwapRoute[] = listSwapRoutes(8453);
const derived: Result<ExecutionResumeState, OseroError> = executionResumeStateFromError(plan, error);
const serialized: Result<string, OseroError> = serializeExecutionResumeState(state);
const restored: Result<ExecutionResumeState, OseroError> = deserializeExecutionResumeState('{}');
const waiting = api.waitForTransferStatus(statusRequest, { timeoutMs: 1_000 });
const gasEstimates: PrepareSwapRequest['gasEstimates'] = 'independent-steps';
const simulationOptions: SimulateExecutionPlanOptions = {};
void [failure, capabilities, feeData, routes, derived, serialized, restored, waiting, gasEstimates, simulationOptions];
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
// @ts-expect-error removed in 1.0: no SDK path ever produced it
import { InsufficientBalanceError } from '@osero/client';
// @ts-expect-error the aggregate action error type was removed in 1.0
import type { ActionError } from '@osero/client';
// @ts-expect-error the capability matrix is internal; listSwapRoutes is the public view
import { CHAIN_CAPABILITIES } from '@osero/client';
// @ts-expect-error neverthrow helpers are not part of the root contract; only the Result types are
import { ok } from '@osero/client';
// @ts-expect-error neverthrow helpers are not part of the root contract; only the Result types are
import { errAsync } from '@osero/client';
// @ts-expect-error testing helpers are not published
import { createMockClient } from '@osero/client';
declare const actionError: ActionError;
void [resolveConfig, flattenExecutionPlan, OseroApiClient, mintUsds, InsufficientBalanceError, CHAIN_CAPABILITIES, ok, errAsync, createMockClient, actionError];
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
      `ethers@${consumerEthersVersion}`,
      `@privy-io/node@${consumerPrivyVersion}`,
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

  // With the optional peers installed at their floors, the two remaining
  // adapters must also typecheck from a consumer, not merely load.
  await writeFile(
    join(consumerRoot, 'consumer-peers.ts'),
    `import type { ExecutionPlan, ExecutionPlanHandler, SendWithError, TransactionResult, Result } from '@osero/client';
import {
  ETHERS_EXECUTOR_CAPABILITIES,
  sendWith as sendWithEthers,
  type SendWithOptions as EthersSendWithOptions,
} from '@osero/client/ethers';
import {
  PRIVY_EXECUTOR_CAPABILITIES,
  sendWith as sendWithPrivy,
  type PrivyExecutorClient,
  type PrivyWallet,
  type SendWithOptions as PrivySendWithOptions,
} from '@osero/client/privy';
import { PrivyClient } from '@privy-io/node';
import { JsonRpcProvider, Wallet, type Signer } from 'ethers';

declare const plan: ExecutionPlan;
const signer: Signer = new Wallet('0x' + '11'.repeat(32), new JsonRpcProvider('http://127.0.0.1:8545'));
const ethersOptions: EthersSendWithOptions = { confirmations: 1, gasBufferBps: 1_500 };
const ethersHandler: ExecutionPlanHandler = sendWithEthers(signer, ethersOptions);
const ethersResult: PromiseLike<Result<TransactionResult, SendWithError>> = sendWithEthers(signer, plan, ethersOptions);

declare const privy: PrivyClient;
// The real Privy client at the peer floor must satisfy the adapter's structural seam.
const executorClient: PrivyExecutorClient = privy;
const wallet: PrivyWallet = { id: 'wallet', address: '0x1111111111111111111111111111111111111111' };
const privyOptions: PrivySendWithOptions = { chainId: 8453, allowPublicRpc: true };
const privyHandler: ExecutionPlanHandler = sendWithPrivy(executorClient, wallet, privyOptions);
const privyResult: PromiseLike<Result<TransactionResult, SendWithError>> = sendWithPrivy(privy, wallet, plan, privyOptions);
void [ETHERS_EXECUTOR_CAPABILITIES, PRIVY_EXECUTOR_CAPABILITIES, ethersHandler, ethersResult, privyHandler, privyResult];
`,
  );
  await writeFile(
    join(consumerRoot, 'tsconfig.peers.json'),
    `${JSON.stringify({ extends: './tsconfig.json', include: ['consumer-peers.ts'] }, null, 2)}\n`,
  );
  run(['exec', 'tsc', '--project', 'tsconfig.peers.json'], consumerRoot);

  console.log(
    `Validated ${metadata.files.length} packed files, every public subpath, optional-peer isolation, and TypeScript 5.9 consumer resolution against viem ${consumerViemVersion}, ethers ${consumerEthersVersion}, and @privy-io/node ${consumerPrivyVersion}`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
