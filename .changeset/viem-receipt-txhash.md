---
'@osero/client': patch
---

Preserve transaction hashes on receipt polling failures and surface them through a dedicated `ReceiptPollingError`. The new error extends `UnexpectedError` for compatibility with existing handlers while giving callers a stable class, `name`, and `txHash` for retry or monitoring flows.
