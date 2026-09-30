---
'@osero/client': major
---

Support the hosted API's 0x integration.

`'0x'` joins `'enso'` and `'lifi'` as a first-class Quote Provider across every
provider discriminator. 0x is one provider spanning the same-chain 0x Swap API
and the 0x Cross-Chain API, so it reports a single tag either way, and its
allowance requirements arrive as ordinary Approval Steps bound to the returned
spender.

- `isOseroApiZeroXProviderDetails` narrows quote Provider Details to the 0x
  support id, curated route, gas and network-fee estimates, and the
  `integratorFee` / `zeroExFee` / `bridgeNativeFee` breakdown.
  `quote.expectedOutput` is already net of all three.
- Status Context is now a provider-discriminated union. A 0x context carries
  the required `providerQuoteId`, which is serialized into every status poll;
  polling a 0x context without it fails locally as a `ValidationError`.
  Unrecognised primitive fields from a future provider's context are echoed
  back unchanged instead of dropped.
- `isOseroApiZeroXTransferStatusProviderDetails` narrows Transfer Status
  Provider Details to the original 0x status, failure reason, and recovery
  status.
- Every Transfer Status gains a nullable `recoveryContext` with normalized
  `state` and `reason`, so a failed cross-chain transfer is no longer
  unconditionally terminal. `waitForSwapCompletion` accepts `waitForRecovery`
  to keep polling while automatic recovery is pending.
- `prepareRecoveryExecutionPlan(status, submitter)` turns a sender-free
  Recovery Action into a wallet-agnostic Execution Plan under the new
  `RECOVER_CROSS_CHAIN_TRANSFER` operation. A recovery deadline becomes the
  plan's quote expiry, so adapters refuse a closed window. Only a `failed`
  transfer whose recovery is `action-required` authorizes a submission; every
  other state is rejected rather than built into a signable plan, and
  `isOseroApiActionableRecovery` narrows to that one submittable combination.
