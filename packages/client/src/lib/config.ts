import type { Transport } from 'viem';

import { type OseroChainId, SUPPORTED_CHAIN_IDS } from './capabilities.js';
import {
  DEFAULT_SLIPPAGE,
  parseSlippage,
  referral,
  type Referral,
  type Slippage,
} from './domain.js';
import { ConfigurationError } from './errors.js';
import type { OseroPublicClient } from './OseroClient.js';

export type ClientConfig = {
  readonly transports?: Partial<Record<OseroChainId, Transport>>;
  readonly publicClients?: Partial<Record<OseroChainId, OseroPublicClient>>;
  /** Public viem RPC URLs are disabled unless explicitly opted into. */
  readonly allowPublicRpc?: boolean;
  readonly defaultSlippage?: Slippage;
  /** No referral attribution is applied unless explicitly configured. */
  readonly referral?: Referral;
};

export type ResolvedClientConfig = {
  readonly transports: Partial<Record<OseroChainId, Transport>>;
  readonly publicClients: Partial<Record<OseroChainId, OseroPublicClient>>;
  readonly allowPublicRpc: boolean;
  readonly defaultSlippage: Slippage;
  readonly referral: Referral;
};

export function resolveConfig(config: ClientConfig): ResolvedClientConfig {
  if (typeof config !== 'object' || config === null) {
    throw new ConfigurationError('Client configuration must be an object');
  }
  if (config.allowPublicRpc !== undefined && typeof config.allowPublicRpc !== 'boolean') {
    throw new ConfigurationError('allowPublicRpc must be a boolean', 'allowPublicRpc');
  }
  if (
    config.transports !== undefined &&
    (typeof config.transports !== 'object' ||
      config.transports === null ||
      Array.isArray(config.transports))
  ) {
    throw new ConfigurationError('transports must be an object keyed by chain id', 'transports');
  }
  if (
    config.publicClients !== undefined &&
    (typeof config.publicClients !== 'object' ||
      config.publicClients === null ||
      Array.isArray(config.publicClients))
  ) {
    throw new ConfigurationError(
      'publicClients must be an object keyed by chain id',
      'publicClients',
    );
  }

  const defaultSlippage =
    config.defaultSlippage === undefined ? DEFAULT_SLIPPAGE : config.defaultSlippage;
  if (typeof defaultSlippage !== 'object' || defaultSlippage === null) {
    throw new ConfigurationError(
      'defaultSlippage must be created with parseSlippage',
      'defaultSlippage',
    );
  }
  const validatedSlippage = parseSlippage({ bps: defaultSlippage.bps });
  if (validatedSlippage.isErr()) {
    throw new ConfigurationError(validatedSlippage.error.message, 'defaultSlippage', {
      cause: validatedSlippage.error,
    });
  }

  const configuredReferral = config.referral === undefined ? false : config.referral;
  let validatedConfiguredReferral: Referral = false;
  if (configuredReferral !== false) {
    if (typeof configuredReferral !== 'object' || configuredReferral === null) {
      throw new ConfigurationError('referral must be false or created with referral()', 'referral');
    }
    const validatedReferral = referral(configuredReferral.code);
    if (validatedReferral.isErr()) {
      throw new ConfigurationError(validatedReferral.error.message, 'referral', {
        cause: validatedReferral.error,
      });
    }
    validatedConfiguredReferral = validatedReferral.value;
  }

  for (const key of [
    ...Object.keys(config.transports ?? {}),
    ...Object.keys(config.publicClients ?? {}),
  ]) {
    const chainId = Number(key);
    if (!(SUPPORTED_CHAIN_IDS as readonly number[]).includes(chainId)) {
      throw new ConfigurationError(`Configuration contains unsupported chain ${key}`, key);
    }
  }

  for (const chainId of SUPPORTED_CHAIN_IDS) {
    const publicClient = config.publicClients?.[chainId];
    if (publicClient?.chain !== undefined && publicClient.chain.id !== chainId) {
      throw new ConfigurationError(
        `Injected public client chain ${publicClient.chain.id} does not match key ${chainId}`,
        `publicClients.${chainId}`,
      );
    }
  }

  return {
    transports: config.transports ?? {},
    publicClients: config.publicClients ?? {},
    allowPublicRpc: config.allowPublicRpc ?? false,
    defaultSlippage: validatedSlippage.value,
    referral: validatedConfiguredReferral,
  };
}
