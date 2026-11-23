---
'@osero/client': patch
---

Verify every repricing against the submitted transaction in the viem and Privy adapters. No export, type, error code, error stage, or default changed. The observable behaviour change is:

**A repricing named by viem must match what was submitted.** When a submitted transaction is replaced (same nonce, different hash), the viem and Privy adapters now accept the replacement as the plan step only if the transaction viem found in the mined block has exactly the sender, target, calldata, and value the adapter submitted, whatever reason viem names. Previously, whenever viem called `onReplaced` with `repriced`, that verdict was taken as given. viem decides `repriced` by comparing the replacement with the transaction the node returns under the submitted hash, so a wallet or RPC that broadcast something other than the request, or returned the hash of a transaction from another account, could get the replacement accepted as the step. `sendWith` in the viem and Privy adapters, and in the EIP-5792 adapter when it falls back to sequential viem execution, now returns `ConfirmationError` at stage `replacement` (message `Transaction <hash> was replaced and cannot be treated as this plan step`, or `was cancelled` when the replacement is a no-op self-transfer), and no later step is broadcast, where it previously succeeded with `replacement.reason: 'repriced'`, in these cases:

- with `confirmations: 1` (the default) on every viem version in the peer range. This makes the one-confirmation path stricter than it has ever been;
- with `confirmations` greater than `1` on viem 2.57.12 and later, which name the reason for every confirmation count (wevm/viem#5284). On earlier viem these cases already failed closed.

A genuine repricing still succeeds and is reported as `repriced`. Cancellations and different transactions fail exactly as before. The check uses the block viem already read for the wait, so it adds no RPC request. The ethers adapter is unchanged. The EIP-5792 atomic batch is unchanged: the adapter cannot verify a wallet-built batch transaction, so during the extra-confirmation wait it still accepts a repricing only when viem reports one.
