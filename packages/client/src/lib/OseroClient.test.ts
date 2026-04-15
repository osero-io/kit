import { UnsupportedChainError } from './errors.js';
import { OseroClient } from './OseroClient.js';

describe('OseroClient', () => {
  it('can be created with no arguments and applies defaults', () => {
    const client = OseroClient.create();
    expect(client.config.defaultSlippageBps).toBe(5);
    expect(client.config.confirmations).toBe(1);
    expect(client.config.transports).toEqual({});
  });

  it('honours caller overrides', () => {
    const client = OseroClient.create({
      defaultSlippageBps: 25,
      confirmations: 3,
    });
    expect(client.config.defaultSlippageBps).toBe(25);
    expect(client.config.confirmations).toBe(3);
  });

  it('throws UnsupportedChainError when asked for an unknown chain', () => {
    const client = OseroClient.create();
    expect(() => client.getPublicClient(999_999_999)).toThrow(UnsupportedChainError);
  });

  it('caches public clients so repeat calls return the same instance', () => {
    const client = OseroClient.create();
    const first = client.getPublicClient(8453);
    const second = client.getPublicClient(8453);
    expect(second).toBe(first);
  });

  it('builds distinct public clients per chain', () => {
    const client = OseroClient.create();
    const base = client.getPublicClient(8453);
    const arb = client.getPublicClient(42161);
    expect(base).not.toBe(arb);
    expect(base.chain?.id).toBe(8453);
    expect(arb.chain?.id).toBe(42161);
  });
});
