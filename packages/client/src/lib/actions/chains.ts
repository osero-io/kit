import {
  type ChainMetadata,
  getChain as getChainFromRegistry,
  listChains as listChainsFromRegistry,
} from '../chains.js';
import type { UnexpectedError } from '../errors.js';
import type { OseroClient } from '../OseroClient.js';
import { okAsync, type ResultAsync } from '../result.js';

/**
 * List every chain that the Osero SDK supports, including the viem
 * `Chain` object that can be used to build public or wallet clients.
 *
 * Returned order matches the order of
 * {@link SUPPORTED_CHAIN_IDS | SUPPORTED_CHAIN_IDS}.
 *
 * ```ts
 * const result = await listChains(client);
 * if (result.isOk()) {
 *   for (const chain of result.value) {
 *     console.log(chain.chainId, chain.name);
 *   }
 * }
 * ```
 *
 * @param _client - Osero client (unused for this action, kept for
 *   consistency with on-chain actions and future extensibility).
 */
export function listChains(
  _client: OseroClient,
): ResultAsync<readonly ChainMetadata[], UnexpectedError> {
  return okAsync(listChainsFromRegistry());
}

/**
 * Look up a single chain by ID. Resolves to `null` (inside an `Ok`)
 * when the chain isn't supported, so callers can handle
 * "unknown chain" with a simple null check rather than an error
 * branch.
 *
 * ```ts
 * const result = await chain(client, { chainId: 8453 });
 * if (result.isOk() && result.value) {
 *   console.log(result.value.name); // "Base"
 * }
 * ```
 */
export function chain(
  _client: OseroClient,
  request: { chainId: number },
): ResultAsync<ChainMetadata | null, UnexpectedError> {
  return okAsync(getChainFromRegistry(request.chainId));
}
