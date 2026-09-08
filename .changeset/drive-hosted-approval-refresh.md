---
'@osero/client': minor
---

Add manual hosted Approval Step and provider-locked Quote Refresh transitions. Insufficient
allowance now returns one exact approval-only Wallet Execution Plan, while refreshed quotes restart
allowance preparation before exposing replacement execution calldata.
