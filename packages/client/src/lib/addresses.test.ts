import { vi } from 'vitest';

import { PSM_ADDRESSES, ensurePsmTargetHasCode, resolvePsmAddresses } from './addresses.js';
import { resolveConfig } from './config.js';
import { UnexpectedError } from './errors.js';
import { OseroClient, type OseroPublicClient } from './OseroClient.js';

const PSM_OVERRIDE = '0x3333333333333333333333333333333333333333' as const;
const LITE_PSM_OVERRIDE = '0x4444444444444444444444444444444444444444' as const;
type MockGetCode = (args: { readonly address: `0x${string}` }) => Promise<`0x${string}`>;

describe('resolvePsmAddresses', () => {
  it('returns built-in PSM addresses when no overrides are configured', () => {
    const config = resolveConfig({});

    expect(resolvePsmAddresses(config, 8453)).toEqual(PSM_ADDRESSES[8453]);
  });

  it('merges partial per-chain overrides over built-in addresses', () => {
    const config = resolveConfig({
      addressOverrides: {
        1: { psm: PSM_OVERRIDE },
        8453: { psm: PSM_OVERRIDE },
      },
    });

    expect(resolvePsmAddresses(config, 1)).toEqual({
      psm: PSM_OVERRIDE,
      litePsm: PSM_ADDRESSES[1].litePsm,
    });
    expect(resolvePsmAddresses(config, 8453)).toEqual({ psm: PSM_OVERRIDE });
  });

  it('allows overriding mainnet lite PSM independently', () => {
    const config = resolveConfig({
      addressOverrides: {
        1: { litePsm: LITE_PSM_OVERRIDE },
      },
    });

    expect(resolvePsmAddresses(config, 1)).toEqual({
      psm: PSM_ADDRESSES[1].psm,
      litePsm: LITE_PSM_OVERRIDE,
    });
  });
});

describe('ensurePsmTargetHasCode', () => {
  it('returns ok when the configured target has deployed code', async () => {
    const client = OseroClient.create();
    const getCode = vi.fn<MockGetCode>(async () => '0x1234' as const);
    client._setPublicClientForTesting(8453, { getCode } as unknown as OseroPublicClient);

    const result = await ensurePsmTargetHasCode(client, 8453, PSM_OVERRIDE);

    expect(result.isOk()).toBe(true);
    expect(getCode).toHaveBeenCalledWith({ address: PSM_OVERRIDE });
  });

  it('returns UnexpectedError when the configured target has no deployed code', async () => {
    const client = OseroClient.create();
    const getCode = vi.fn<MockGetCode>(async () => '0x' as const);
    client._setPublicClientForTesting(8453, { getCode } as unknown as OseroPublicClient);

    const result = await ensurePsmTargetHasCode(client, 8453, PSM_OVERRIDE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toContain(PSM_OVERRIDE);
    }
  });
});
