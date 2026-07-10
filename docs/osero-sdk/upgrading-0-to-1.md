# Upgrade from 0.x to 1.0

`@osero/client` 1.0 keeps the local action builders and wallet adapters stable, but changes the hosted Osero API client from an sUSDS-only quote surface to a flexible swap surface where the hosted API — not the SDK — decides which assets and pairs are supported.

Use this guide if your app imports from `@osero/client/api` or checks `TransactionRequest.operation` for hosted API quotes.

## What changed

### Hosted quotes accept any asset ref

In 0.x, `getSwapQuote` was typed as one of two directional requests:

- supported counter asset → `ethereum:susds`
- `ethereum:susds` → supported counter asset

In 1.0, `getSwapQuote` accepts any `OseroApiAssetRef` and forwards it to the
hosted API, which is the sole authority on supported assets and pairs. USDS
routes are symmetric on the hosted API today:

- every supported non-USDS asset can quote into `ethereum:usds`
- `ethereum:usds` can quote back out to every supported non-USDS asset
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

### The SDK ships no gating registry

1.0 removes every client-side allowlist. The `OSERO_API_KNOWN_*` exports are
advisory snapshots of what the hosted API served when the SDK release was cut —
they power editor autocomplete and offline UI hints, and nothing else. No
request or response is validated against them:

- **Requests** accept any asset ref. Known ids autocomplete; arbitrary string
  ids pass through unchanged, while `{ chainId, address }` locators serialize
  to `'<chainId>:<lowercase address>'`. The hosted API
  rejects unsupported refs with HTTP 400 and the stable code
  `SWAP_ASSET_NOT_SUPPORTED`, surfaced as `ApiRequestError.code`. (Refs must
  match the wire grammar — two non-whitespace segments joined by a colon, at
  most 128 characters; anything else fails the API's request validation with
  a plain 400 that carries no stable code.)
- **Responses** decode structurally. Assets, chains, protocols, kinds,
  directions, and states unknown to your SDK release decode normally, so a
  deployed build keeps working as the API evolves.

Call `getSupportedAssets()` for the sanctioned live list, and use
`matchOseroApiAsset(assets, ref)` when a UI wants to pre-flight a ref against
that live data.

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

## Renamed and removed API registry exports

Registry-style exports carry a `KNOWN_` prefix in 1.0 to make their role
explicit: they describe what this SDK release knows about, not what the API
accepts. Anything that existed only to gate requests is removed.

| 0.x export                                                                           | 1.0 replacement                                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `OSERO_API_COUNTER_ASSETS` / `OSERO_API_SWAP_ASSETS` / `OSERO_API_ASSETS`            | `OSERO_API_KNOWN_ASSETS` — advisory; rows are `{ assetId, symbol, decimals, kind }` (the `canSwapFrom` / `canSwapTo` columns are gone) |
| `OSERO_API_COUNTER_ASSET_IDS` / `OSERO_API_PUBLIC_ASSET_IDS` / `OSERO_API_ASSET_IDS` | `OSERO_API_KNOWN_ASSET_IDS` (advisory)                                                                                                 |
| `OSERO_API_CHAINS`                                                                   | `OSERO_API_KNOWN_CHAINS`                                                                                                               |
| `OSERO_API_CHAIN_IDS`                                                                | `OSERO_API_KNOWN_CHAIN_IDS`                                                                                                            |
| `OSERO_API_BRIDGE_PROTOCOLS`                                                         | `OSERO_API_KNOWN_BRIDGE_PROTOCOLS`                                                                                                     |
| `OSERO_API_INPUT_ASSETS` / `OSERO_API_OUTPUT_ASSETS`                                 | Removed — there is no client-side input/output split. Use `OseroApiAssetRef` in requests and `getSupportedAssets()` for live data      |
| `OSERO_API_INPUT_ASSET_IDS` / `OSERO_API_OUTPUT_ASSET_IDS`                           | Removed — same recipe: `OseroApiAssetRef` in requests, `getSupportedAssets()` for live data                                            |
| `OseroApiInputAsset` / `OseroApiOutputAsset`                                         | Removed — use `OseroApiKnownAsset` (snapshot rows) or `OseroApiSupportedAsset` (live rows)                                             |
| `OseroApiInputAssetId` / `OseroApiOutputAssetId`                                     | Removed — request fields take `OseroApiAssetRef`; plain string ids are `OseroApiAssetId`                                               |
| `OSERO_API_SOURCE_CHAIN_IDS` / `OseroApiSourceChainId`                               | Removed — `sourceChainId` is any positive integer, typed `OseroApiChainId`                                                             |
| `OSERO_API_SWAP_DIRECTIONS`                                                          | Removed runtime array — the `OseroApiSwapDirection` type remains, widened to admit directions the API adds later                       |
| `OSERO_API_VAULT_ASSET`                                                              | Look up `OSERO_API_SUSDS_ASSET_ID` in `OSERO_API_KNOWN_ASSETS` or in live `getSupportedAssets()` data                                  |
| `OseroApiAsset`                                                                      | `OseroApiKnownAsset`                                                                                                                   |
| `OseroApiChain`                                                                      | `OseroApiKnownChain`                                                                                                                   |
| `OseroApiAssetSymbol`                                                                | `string`                                                                                                                               |
| `OseroApiAssetDecimals`                                                              | `number`                                                                                                                               |
| `OseroApiCounterAssetId` / `OseroApiPublicAssetId`                                   | `OseroApiAssetId` (known ids plus any string)                                                                                          |
| `OseroApiToSusdsQuoteRequest` / `OseroApiFromSusdsQuoteRequest`                      | `OseroApiSwapQuoteRequest`                                                                                                             |

New 1.0 exports:

```ts
import {
  matchOseroApiAsset,
  OSERO_API_ERROR_CODES,
  OSERO_API_KNOWN_ASSET_IDS,
  OSERO_API_KNOWN_ASSETS,
  OSERO_API_KNOWN_BRIDGE_PROTOCOLS,
  OSERO_API_KNOWN_CHAIN_IDS,
  OSERO_API_KNOWN_CHAINS,
  OSERO_API_SUSDS_ASSET_ID,
  OSERO_API_USDS_ASSET_ID,
  type OseroApiAssetId,
  type OseroApiAssetLocator,
  type OseroApiAssetRef,
  type OseroApiErrorCode,
  type OseroApiKnownAsset,
  type OseroApiKnownAssetId,
  type OseroApiKnownBridgeProtocol,
  type OseroApiKnownChain,
  type OseroApiKnownChainId,
  type OseroApiKnownChainKey,
  type OseroApiSwapQuoteRequest,
} from '@osero/client/api';
```

## Asset refs

`fromAssetId` and `toAssetId` accept any of three forms:

```ts
// 1. A canonical asset id. Ids in OSERO_API_KNOWN_ASSET_IDS autocomplete,
//    but any string passes through — the API decides whether it is supported.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: 'ethereum:usdc',
  toAssetId: OSERO_API_USDS_ASSET_ID,
  amount: parseUnits('1', 6),
});

// 2. An address-form string: '<chainId>:<0xaddress>'.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
  toAssetId: OSERO_API_USDS_ASSET_ID,
  amount: parseUnits('1', 6),
});

// 3. A structured locator — serialized to '<chainId>:<lowercase address>' on the wire.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: { chainId: 8453, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  toAssetId: OSERO_API_USDS_ASSET_ID,
  amount: parseUnits('1', 6),
});
```

When the API supports the referenced token, it resolves the ref and echoes the
canonical asset id back in `quote.pair`. When it does not, the request fails
with HTTP 400 and `ApiRequestError.code === 'SWAP_ASSET_NOT_SUPPORTED'`.

To pre-flight a ref in a UI ("is this token supported?"), match it against
live data instead of a shipped snapshot:

```ts
import { matchOseroApiAsset } from '@osero/client/api';

const assets = await api.getSupportedAssets();
if (assets.isOk()) {
  const match = matchOseroApiAsset(assets.value.assets, {
    chainId: 8453,
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  });
  // `match` is the live OseroApiSupportedAsset row, or undefined when the
  // API does not currently list the token.
}
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
// Any supported non-USDS asset → USDS, for example USDC → USDS.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: 'ethereum:usdc',
  toAssetId: OSERO_API_USDS_ASSET_ID,
  amount: parseUnits('1', 6),
});

// USDS → any supported non-USDS asset, for example USDS → USDC.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: OSERO_API_USDS_ASSET_ID,
  toAssetId: 'ethereum:usdc',
  amount: parseUnits('1', 18),
});

// Other supported assets such as sUSDS, USDe, and USDT also quote into USDS.
await api.getSwapQuote({
  fromAddress,
  fromAssetId: 'ethereum:usdt',
  toAssetId: OSERO_API_USDS_ASSET_ID,
  amount: parseUnits('1', 6),
});
```

## Validation behavior

0.x validated requests against the shipped registry before making an HTTP
request. 1.0 validates **wire grammar and execution safety only** — anything
the API might legitimately accept passes through, and the API's verdict comes
back as an `ApiRequestError`, with a stable `code` when the endpoint supplies
one.

Still checked locally (returned as `ValidationError` through `ResultAsync`, no
HTTP request made):

- `fromAddress` is an EVM address
- `fromAssetId` / `toAssetId` string refs are non-empty; locator refs have a
  positive integer `chainId` and a well-formed EVM `address`
- `amount` is a positive uint256-compatible integer
- `txHash` (status requests) is a 32-byte hex string; `sourceChainId` is a
  positive integer and `bridgeProtocol` is a non-empty string
- `apiKey` is a non-empty printable ASCII string

Moved to the API (0.x rejected these locally; 1.0 sends the request and the
API answers with HTTP 400 or 401):

- asset existence and pair membership — 0.x checked `fromAssetId` /
  `toAssetId` against input/output id arrays and rejected
  `fromAssetId === toAssetId`; 1.0 surfaces the API's
  `SWAP_ASSET_NOT_SUPPORTED` / `SWAP_PAIR_NOT_SUPPORTED` codes instead
- slippage format and cap — `SLIPPAGE_INVALID` / `SLIPPAGE_OUT_OF_RANGE`
- `referralCode` range — the SDK only requires a finite number so the value
  can serialize
- API key prefix and credential validity — a printable-ASCII but invalid key is a 401

> **Behavior change worth calling out:** a typo'd asset id in 0.x failed
> synchronously with a `ValidationError` before any network call. In 1.0 the
> same typo costs a round-trip and comes back as an `ApiRequestError` with
> `code: 'SWAP_ASSET_NOT_SUPPORTED'`. If your UI relied on the synchronous
> failure, pre-flight against `getSupportedAssets()` + `matchOseroApiAsset`
> instead.

Responses are decoded structurally. The decoder still enforces wire formats
(addresses, hex payloads, integer strings, 32-byte hashes) and exactly these
execution-safety invariants: the approval transaction targets the approval
token, carries zero value, shares its sender with the execution transaction,
and belongs to the execution source chain; bridge-tracked quotes
(`bridge.required === true`) carry a non-null `protocol` and `statusRequest`
whose source chain matches the execution source chain. Everything else —
unknown assets, chains, protocols, kinds, directions, and states — decodes
normally.

> **Type migration:** `bridge.required === true` still narrows `protocol` and
> `statusRequest` to non-null values. The `false` arm now types each field as
> its value or `null` because structurally valid same-chain responses may carry
> informational bridge metadata. Code that previously assumed both fields were
> `null` after `if (!bridge.required)` must null-check them.

## Error handling

Three error shapes cover every hosted API call. Narrow with `instanceof`
(which TypeScript understands — `error.name` is typed `string` and does not
narrow), then inspect status/body and branch on `error.code` when present:

```ts
import { ApiRequestError, ValidationError } from '@osero/client';

const quote = await api.getSwapQuote(request);

if (quote.isErr()) {
  if (quote.error instanceof ValidationError) {
    // Local format problem — malformed address, empty asset ref, bad
    // amount. No HTTP request was made.
  } else if (quote.error instanceof ApiRequestError) {
    // The API's verdict. When present, `code` is machine-readable and stable.
    switch (quote.error.code) {
      case 'SWAP_ASSET_NOT_SUPPORTED':
        // The asset ref does not resolve to a supported asset.
        break;
      default:
        // The API may add codes at any time — always keep a default arm.
        console.error(quote.error.statusCode, quote.error.code, quote.error.message);
    }
  } else {
    // UnexpectedError: the response was malformed or violated the SDK's
    // decode contract.
  }
}
```

## Widened unions need `default` arms

API identifier and vocabulary types (`OseroApiAssetId`, `OseroApiChainId`,
`OseroApiChainKey`, `OseroApiBridgeProtocol`, `OseroApiAssetKind`,
`OseroApiSwapDirection`, `OseroApiSwapExecutionKind`, `OseroApiBridgeState`,
`OseroApiBridgeProviderStatus`, `OseroApiErrorCode`) pair their known literals
with an open tail such as `(string & {})`. Known values still autocomplete and
narrow, but values the API adds after your SDK release remain representable —
so never exhaustively `switch` on them without a `default` arm.

```ts
switch (status.value.bridge.state) {
  case 'pending':
    /* ... */ break;
  case 'completed':
    /* ... */ break;
  case 'failed':
    /* ... */ break;
  default:
    // Future states decode fine; treat unknowns conservatively.
    break;
}
```

## Local actions are unchanged

These action builders keep their 0.x request shapes and exact-in semantics:

- `mintUsds`: USDC → USDS
- `mintSUsds`: USDC → sUSDS
- `redeemUsds`: USDS → USDC
- `redeemSUsds`: sUSDS → USDC

Use `@osero/client/api` for flexible hosted routes beyond those local PSM action helpers.

## Checklist

1. Replace removed or renamed API registry exports with the advisory
   `KNOWN_`-prefixed names above; delete any logic that gated requests on them.
2. Replace `OseroApiToSusdsQuoteRequest` / `OseroApiFromSusdsQuoteRequest` with `OseroApiSwapQuoteRequest`.
3. Move pre-flight asset checks from shipped id arrays to
   `getSupportedAssets()` + `matchOseroApiAsset`.
4. Handle `ApiRequestError` (and `.code` when present, for example
   `SWAP_ASSET_NOT_SUPPORTED`) where 0.x expected a synchronous
   `ValidationError` for unsupported assets, slippage, or referral codes.
5. Add `default` arms to `switch` statements over the widened API unions.
6. Update UI or analytics logic that expected hosted quote operations to be `MINT_SUSDS` or `REDEEM_SUSDS_FOR_USDC`; expect `SWAP` instead.
7. Use `quote.pair.from` and `quote.pair.to` for route labels and token decimals.
8. Keep `neverthrow` handling. Do not wrap SDK calls in `try/catch` unless you are catching your own code around them.
