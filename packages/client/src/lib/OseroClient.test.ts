import { parseSlippage, referral } from './domain.js';
import { ConfigurationError, UnsupportedChainError } from './errors.js';
import { OseroClient } from './OseroClient.js';

function configuredDefaults() {
  const slippage = parseSlippage({ bps: '25' });
  const referralValue = referral(3001n);
  if (slippage.isErr() || referralValue.isErr()) throw new Error('test input failed');
  return { slippage: slippage.value, referral: referralValue.value };
}

describe('OseroClient', () => {
  it('exposes explicit safe defaults without silently enabling public RPCs', () => {
    const client = OseroClient.create();

    expect(client.defaults.slippage.bps).toBe('5');
    expect(client.defaults.referral).toBe(false);
    const publicClient = client.getPublicClient(8453);
    expect(publicClient.isErr()).toBe(true);
    if (publicClient.isErr()) expect(publicClient.error).toBeInstanceOf(ConfigurationError);
  });

  it('honors branded slippage and referral overrides', () => {
    const defaults = configuredDefaults();
    const client = OseroClient.create({
      defaultSlippage: defaults.slippage,
      referral: defaults.referral,
    });

    expect(client.defaults).toEqual(defaults);
  });

  it('returns UnsupportedChainError instead of throwing for unknown chains', () => {
    const result = OseroClient.create().getPublicClient(999_999_999);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(UnsupportedChainError);
  });

  it('allows public RPC fallback only after explicit opt-in and caches each chain', () => {
    const client = OseroClient.create({ allowPublicRpc: true });
    const first = client.getPublicClient(8453);
    const second = client.getPublicClient(8453);
    const arbitrum = client.getPublicClient(42161);
    if (first.isErr() || second.isErr() || arbitrum.isErr()) {
      throw new Error('public client creation failed');
    }

    expect(second.value).toBe(first.value);
    expect(first.value.chain?.id).toBe(8453);
    expect(arbitrum.value.chain?.id).toBe(42161);
    expect(arbitrum.value).not.toBe(first.value);
  });

  it('rejects malformed configuration at construction', () => {
    expect(() => OseroClient.create(null as never)).toThrow(ConfigurationError);
    expect(() => OseroClient.create({ allowPublicRpc: 'yes' as never })).toThrow(
      ConfigurationError,
    );
  });
});
