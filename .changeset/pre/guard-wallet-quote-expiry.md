---
'@osero/client': minor
---

Add optional hosted quote expiry constraints to Wallet Execution Plans. Expiry now participates in
plan identity and persistence, and viem, ethers, and Privy executions fail with a typed
`QuoteExpiredError` when the quote expires before broadcast.
