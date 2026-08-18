import type { Transport } from 'viem';

import { resolveConfig, type ClientConfig } from './config.js';
import { parseSlippage, referral } from './domain.js';
import { ConfigurationError } from './errors.js';
import type { OseroPublicClient } from './OseroClient.js';

function expectConfigurationError(config: ClientConfig): void {
  expect(() => resolveConfig(config)).toThrow(ConfigurationError);
}

describe('resolveConfig', () => {
  it('materializes immutable policy defaults without public RPC fallback', () => {
    const resolved = resolveConfig({});

    expect(resolved).toMatchObject({
      allowPublicRpc: false,
      transports: {},
      publicClients: {},
      referral: false,
    });
    expect(resolved.defaultSlippage.bps).toBe('5');
  });

  it('accepts branded slippage and referral values', () => {
    const slippage = parseSlippage({ bps: '25.5' });
    const referralValue = referral(3001n);
    if (slippage.isErr() || referralValue.isErr()) throw new Error('test input failed');

    const resolved = resolveConfig({
      allowPublicRpc: true,
      defaultSlippage: slippage.value,
      referral: referralValue.value,
    });

    expect(resolved.allowPublicRpc).toBe(true);
    expect(resolved.defaultSlippage.bps).toBe('25.5');
    expect(resolved.referral).toEqual({ code: 3001n });
  });

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
