# Upgrade from 0.x to 1.0

`@osero/client` 1.0 keeps the local action builders and wallet adapters stable, but changes the hosted Osero API client from an sUSDS-only quote surface to a flexible swap surface.

Use this guide if your app imports from `@osero/client/api` or checks `TransactionRequest.operation` for hosted API quotes.

## What changed

### Hosted quotes support flexible asset pairs

In 0.x, `getSwapQuote` was typed as one of two directional requests:

- supported counter asset → `ethereum:susds`
- `ethereum:susds` → supported counter asset

In 1.0, `getSwapQuote` accepts registered input/output asset pairs. USDS routes
are symmetric across the hosted registry:

- every registered non-USDS asset can quote into `ethereum:usds`
- `ethereum:usds` can quote back out to every registered non-USDS asset
- examples include USDC → USDS, sUSDS → USDS, USDe → USDS, USDT → USDS, and
  USDS → USDC
- `ethereum:susds` remains a valid input and output

```ts
import { OseroApiClient, OSERO_API_USDS_ASSET_ID } from '@osero/client/api';
import { parseUnits } from 'viem';

const api = OseroApiClient.create({ apiKey: process.env.OSERO_API_KEY! });

const quote = await api.getSwapQuote({
  fromAddress: '0x1111111111111111111111111111111111111111',
  fromAssetId: 'ethereum:usdt',
  toAssetId: OSERO_API_USDS_ASSET_ID,
  amount: parseUnits('1', 6),
});
```

The public developer-facing API still returns `ResultAsync`, so existing `.map`, `.andThen`, `.isOk`, and `.isErr` flows remain the intended integration style.

### API execution plans use `SWAP`

Hosted API quote execution transactions now use a generic operation tag:

```ts
flattenExecutionPlan(quote.value.executionPlan).map((tx) => tx.operation);
// 1.0: ['APPROVE_ERC20', 'SWAP']
```

0.x inferred `MINT_SUSDS` or `REDEEM_SUSDS_FOR_USDC` from the sUSDS direction. That inference was removed because a quote may now be USDS → USDC, USDT → USDS, sUSDS → USDS, or future asset pairs that do not fit mint/redeem labels.

If your UI labels API quote transactions, derive labels from `quote.pair.from` and `quote.pair.to` instead of from the operation string.

```ts
const label = `${quote.value.pair.from.symbol} → ${quote.value.pair.to.symbol}`;
```

Local action builders still use their existing operation tags (`MINT_USDS`, `MINT_SUSDS`, `REDEEM_USDS_FOR_USDC`, etc.). Only hosted API quote execution plans changed to `SWAP`.

## Renamed API registry exports

The hosted API registry is now capability-driven. Replace the old sUSDS/counter names with input/output asset names:

| 0.x export                                                      | 1.0 replacement                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `OSERO_API_COUNTER_ASSETS`                                      | `OSERO_API_SWAP_ASSETS` or `OSERO_API_INPUT_ASSETS` / `OSERO_API_OUTPUT_ASSETS` |
| `OSERO_API_COUNTER_ASSET_IDS`                                   | `OSERO_API_INPUT_ASSET_IDS` / `OSERO_API_OUTPUT_ASSET_IDS`                      |
| `OSERO_API_PUBLIC_ASSET_IDS`                                    | `OSERO_API_ASSET_IDS`                                                           |
| `OSERO_API_VAULT_ASSET`                                         | lookup `OSERO_API_SUSDS_ASSET_ID` in `OSERO_API_ASSETS`                         |
| `OseroApiCounterAssetId`                                        | `OseroApiInputAssetId` or `OseroApiOutputAssetId`                               |
| `OseroApiPublicAssetId`                                         | `OseroApiAssetId`                                                               |
| `OseroApiToSusdsQuoteRequest` / `OseroApiFromSusdsQuoteRequest` | `OseroApiSwapQuoteRequest`                                                      |

New 1.0 exports:

```ts
import {
  OSERO_API_ASSET_IDS,
  OSERO_API_ASSETS,
  OSERO_API_INPUT_ASSET_IDS,
  OSERO_API_INPUT_ASSETS,
  OSERO_API_OUTPUT_ASSET_IDS,
  OSERO_API_OUTPUT_ASSETS,
  OSERO_API_SUSDS_ASSET_ID,
  OSERO_API_SWAP_ASSETS,
  OSERO_API_USDS_ASSET_ID,
  type OseroApiAssetId,
  type OseroApiInputAssetId,
  type OseroApiOutputAssetId,
  type OseroApiSwapQuoteRequest,
} from '@osero/client/api';
```

## Request migration

### 0.x: counter asset → sUSDS

```ts
await api.getSwapQuote({
  fromAddress,
  fromAssetId: 'base:usdc',
  toAssetId: 'ethereum:susds',
  amount: parseUnits('1', 6),
});
```

### 1.0: same request still works

```ts
await api.getSwapQuote({
  fromAddress,
  fromAssetId: 'base:usdc',
  toAssetId: OSERO_API_SUSDS_ASSET_ID,
  amount: parseUnits('1', 6),
});
```

### 1.0: USDS hub routes

```ts
// Any registered non-USDS asset → USDS, for example USDC → USDS.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: 'ethereum:usdc',
  toAssetId: OSERO_API_USDS_ASSET_ID,
  amount: parseUnits('1', 6),
});

// USDS → any registered non-USDS asset, for example USDS → USDC.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: OSERO_API_USDS_ASSET_ID,
  toAssetId: 'ethereum:usdc',
  amount: parseUnits('1', 18),
});

// Other registered assets such as sUSDS, USDe, and USDT also quote into USDS.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: 'ethereum:usdt',
  toAssetId: OSERO_API_USDS_ASSET_ID,
  amount: parseUnits('1', 6),
});
```

## Validation behavior

`getSwapQuote` still validates before making an HTTP request. In 1.0 it checks:

- `fromAddress` is an EVM address
- `fromAssetId` is in `OSERO_API_INPUT_ASSET_IDS`
- `toAssetId` is in `OSERO_API_OUTPUT_ASSET_IDS`
- `fromAssetId !== toAssetId`
- `amount` is a positive uint256-compatible integer
- optional `slippage` and `referralCode` are in range

Unsupported inputs return `ValidationError` through `ResultAsync`; they do not throw.

## Local actions are unchanged

These action builders keep their 0.x request shapes and exact-in semantics:

- `mintUsds`: USDC → USDS
- `mintSUsds`: USDC → sUSDS
- `redeemUsds`: USDS → USDC
- `redeemSUsds`: sUSDS → USDC

Use `@osero/client/api` for flexible hosted routes beyond those local PSM action helpers.

## Checklist

1. Replace removed API registry exports with the 1.0 names above.
2. Replace `OseroApiToSusdsQuoteRequest` / `OseroApiFromSusdsQuoteRequest` with `OseroApiSwapQuoteRequest`.
3. Update UI or analytics logic that expected hosted quote operations to be `MINT_SUSDS` or `REDEEM_SUSDS_FOR_USDC`; expect `SWAP` instead.
4. Use `quote.pair.from` and `quote.pair.to` for route labels and token decimals.
5. Keep `neverthrow` handling. Do not wrap SDK calls in `try/catch` unless you are catching your own code around them.
