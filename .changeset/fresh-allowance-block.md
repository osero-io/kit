---
'@osero/client': patch
---

`executeSwap` no longer sends a redundant approval after an approval has confirmed. No export, type, error code, or default changed.

**What was wrong.** After an approval confirmed, `executeSwap` refreshed the quote and re-read the allowance at the block returned by `getBlockNumber()`. viem answers that call from a cache for the client's `cacheTime` (4 seconds on Ethereum by default). When the approval confirmed inside that window, the allowance was read at a block from before the approval, came back as insufficient, and the same approval was sent again. Each repeat cost gas and a wallet prompt, and enough of them ended the swap with `ApprovalLimitError`. Setting `cacheTime: 0` on the public client was the only way to avoid it.

**What changed.**

- `getSwapQuote`, `refreshSwapQuote`, and `executeSwap` read the allowance at a fresh block: they call `getBlockNumber({ cacheTime: 0 })` on the client from `publicClientProvider`. This is one uncached `eth_blockNumber` request per chain for each quote that has an Approval Step to check. Quotes without one make no RPC request, as before.
- Inside `executeSwap`, the allowance check after a confirmed approval never reads below that approval's receipt block (`confirmation.blockNumber` of the approval result, when the handler reports it). If the RPC still reports an older head, the SDK asks again up to four times, 250 ms apart, and then reads at the receipt block. An RPC that cannot serve that block returns `RpcError` and no further approval is requested. Cancelling through `signal` during the wait returns `CancelError`.
- `simulateExecutionPlan`, `quoteSwap`, and `prepareSwap` now also pin their reads to a fresh block in the same way. A simulation, quote, or prepared plan requested right after a transaction no longer reflects state from before it.

Approval and refresh limits, progress events and their order, and the hosted API requests are unchanged.
