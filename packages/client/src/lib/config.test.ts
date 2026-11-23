import type { Transport } from 'viem';

import { resolveConfig, type ClientConfig } from './config.js';
import { ConfigurationError } from './errors.js';
import type { OseroPublicClient } from './OseroClient.js';

function expectConfigurationError(config: ClientConfig): void {
  expect(() => resolveConfig(config)).toThrow(ConfigurationError);
}

describe('resolveConfig', () => {
  it('rejects non-object and malformed policy fields', () => {
    expectConfigurationError(null as never);
    expectConfigurationError({ allowPublicRpc: 'yes' as never });
    expectConfigurationError({ transports: null as never });
    expectConfigurationError({ transports: [] as never });
    expectConfigurationError({ publicClients: null as never });
    expectConfigurationError({ publicClients: [] as never });
    expectConfigurationError({ defaultSlippage: null as never });
    expectConfigurationError({ defaultSlippage: { bps: '10001' } as never });
    expectConfigurationError({ referral: null as never });
    expectConfigurationError({ referral: '3000' as never });
    expectConfigurationError({ referral: { code: -1n } as never });
  });

  it('rejects unsupported transport and public-client keys', () => {
    expectConfigurationError({
      transports: { 137: (() => undefined) as unknown as Transport },
    } as never);
    expectConfigurationError({
      publicClients: { 137: { chain: { id: 137 } } as OseroPublicClient },
    } as never);
  });

  it('rejects an injected public client whose chain does not match its key', () => {
    expectConfigurationError({
      publicClients: {
        8453: { chain: { id: 1 } } as OseroPublicClient,
      },
    });
  });
});
