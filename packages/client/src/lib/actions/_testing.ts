import { vi } from 'vitest';

import type { OseroChainId } from '../chains.js';
import type { OseroClient, OseroPublicClient } from '../OseroClient.js';

/**
 * Mock scaffolding used by every action test. The `readContract`
 * method is replaced by a `vi.fn()` that dispatches by `functionName`
 * so each test can set the read it cares about without building a
 * whole viem-compatible transport.
 *
 * @internal
 */
export type MockReadRouter = (args: {
  readonly address: `0x${string}`;
  readonly functionName: string;
  readonly args?: readonly unknown[];
}) => unknown;

/**
 * Install a fake viem public client onto the given OseroClient for a
 * specific chain. Returns the fake so tests can inspect call
 * arguments.
 *
 * @internal
 */
export function installMockPublicClient(
  client: OseroClient,
  chainId: OseroChainId,
  router: MockReadRouter,
): { readContract: ReturnType<typeof vi.fn> } {
  // Wrap the router in an async function so that synchronous throws
  // inside the router turn into rejected promises. Without this, a
  // `throw` in the router escapes up the stack and crashes the caller
  // before neverthrow can observe it.
  const mock = {
    readContract: vi.fn<(args: Parameters<MockReadRouter>[0]) => Promise<unknown>>(async (args) =>
      router(args),
    ),
  };
  // Cast through `unknown` because the mock only implements the
  // subset of viem's PublicClient surface that actions actually use.
  client._setPublicClientForTesting(chainId, mock as unknown as OseroPublicClient);
  return mock;
}
