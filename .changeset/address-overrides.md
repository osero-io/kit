---
'@osero/client': patch
---

Add configurable PSM address overrides and verify configured PSM targets have deployed code before returning transaction plans. Actions now perform an `eth_getCode` check for the resolved PSM target before building approval or swap calldata.
