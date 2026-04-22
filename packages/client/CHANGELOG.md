# @osero/client

## 0.4.1

### Patch Changes

- 4d83de1: Update repository URLs in package.json after repo rename from `osero-kit` to `kit`

## 0.4.0

### Minor Changes

- fc7472f: Apply a built-in `DEFAULT_REFERRAL_CODE` (`3000n`) to every action whenever the request does not specify one, add a new `ClientConfig.defaultReferralCode` field to override or opt out at the client level, and treat `referralCode: undefined` on a request as a per-call opt-out. Upgrading without further action will emit `3000n` where calls previously emitted `0n` on PSM3 `Swap` events and the sUSDS `deposit` referral overload.

## 0.3.0

### Minor Changes

- 7d3960c: Add mainnet `mintSUsds` referral support via the sUSDS deposit referral overload while keeping the SDK request shape consistent across mainnet and L2 chains. Update examples to show referral code usage for sUSDS mint flows.

## 0.2.0

### Minor Changes

- 2d62b1d: Add preview helpers for the exact-in USDC, USDS, and sUSDS flows. The client can now quote expected outputs for `previewMintUsds`, `previewMintSUsds`, `previewRedeemUsds`, and `previewRedeemSUsds` across mainnet and supported L2s.

## 0.1.0

### Minor Changes

- 172f7ec: Add ergonomic helpers for reading canonical `USDC`, `USDS`, and `sUSDS` balances through `OseroClient`. This release also updates the roundtrip examples to use the new helpers instead of wiring token contracts manually.
