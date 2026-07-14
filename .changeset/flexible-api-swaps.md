---
'@osero/client': major
---

Replace the 0.x pair-specific preview/action surface with a single typed `prepareSwap` API. It
returns a rich exact-input or exact-output quote tied to a flat, versioned, account/chain-bound
`ExecutionPlan`. Amounts, slippage, referrals, approval policy, and unprotected-route consent are
explicit domain inputs. Referral attribution and public RPC fallback default to disabled, while
allowance-aware exact approvals are the default.

Wallet adapters now preflight the complete plan before broadcasting, estimate fresh buffered gas,
report truthful signing/broadcast/confirmation/revert stages, preserve submitted and replacement
hashes, emit progress, and support receipt-verified confirmed-prefix recovery. Every SDK error has
stable literal discriminants and contextual JSON output; operational calls keep failures in
`Result`/`ResultAsync`.

The public surface is intentionally split across the root, `/actions`, `/api`, `/contracts`,
`/viem`, `/ethers`, and `/privy` entrypoints. Legacy local action functions, nested plan variants,
and internal flattening/type-guard helpers are removed.

Refactor the hosted Osero API client around API-authoritative asset refs. The SDK no longer ships a gating registry, so a deployed build keeps working as the hosted API adds and removes assets, chains, and bridge protocols.

`getSwapQuote` accepts any asset ref — a canonical id (`'ethereum:usdc'`), an arbitrary string id, or a `{ chainId, address }` locator encoded on the wire as `'<chainId>:<0xaddress>'`. Known ids still autocomplete, but nothing is rejected locally on membership: the hosted API is the sole authority and answers unsupported refs with HTTP 400 and a stable API response code (for example `SWAP_ASSET_NOT_SUPPORTED`). That server code is exposed as `ApiRequestError.apiCode`; `ApiRequestError.code` remains the SDK error discriminant `API_REQUEST_FAILED`. Responses decode structurally, so assets, chains, protocols, kinds, directions, and states unknown to this SDK release decode normally.

Registry exports are renamed to advisory `KNOWN_` snapshots — `OSERO_API_KNOWN_ASSETS`, `OSERO_API_KNOWN_CHAINS`, `OSERO_API_KNOWN_ASSET_IDS`, `OSERO_API_KNOWN_CHAIN_IDS`, and `OSERO_API_KNOWN_BRIDGE_PROTOCOLS` — that only power editor autocomplete and offline UI hints. The input/output splits (`OSERO_API_INPUT_*`, `OSERO_API_OUTPUT_*`, `OseroApiInputAssetId`, `OseroApiOutputAssetId`) and the source-chain allowlist (`OSERO_API_SOURCE_CHAIN_IDS`, `OseroApiSourceChainId`) are removed. `getSupportedAssets()` is the sanctioned live list, and the new `matchOseroApiAsset(assets, ref)` helper pre-flights a ref against it.

Client-side validation narrows to wire grammar and execution safety (EVM addresses, hex payloads, uint256 amounts, 32-byte tx hashes). Server-policy checks that 0.x ran locally are now enforced by the API instead of pre-flight `ValidationError`s: asset/pair membership and slippage failures come back as 400s with stable codes (`SWAP_ASSET_NOT_SUPPORTED`, `SWAP_PAIR_NOT_SUPPORTED`, `SLIPPAGE_INVALID`, `SLIPPAGE_OUT_OF_RANGE`), an out-of-range referral code is a plain 400 from request validation, and a printable-ASCII but invalid API key is a 401. Empty keys and keys containing non-ASCII, whitespace, or control characters remain local `ValidationError`s. `getTokenBalance` additionally accepts any ERC-20 address alongside the canonical token symbols.

Hosted API quote execution plans tag execution transactions as `SWAP_EXACT_IN`; derive user-facing labels from `quote.pair.from` and `quote.pair.to`. See `docs/osero-sdk/upgrading-0-to-1.md` for the full migration guide.
