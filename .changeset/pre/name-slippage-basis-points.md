---
'@osero/client': major
---

Require slippage inputs to name basis points explicitly.

`parseSlippage` now accepts `{ bps: string }`, rejecting the legacy unitless string input.
