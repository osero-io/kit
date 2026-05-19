---
'@osero/client': patch
---

Guard Ethereum mainnet `mintUsds` execution against Lite PSM `tin` increases before `sellGem` is broadcast. Mainnet plans now read `tin()` once while building the guarded transaction and SDK adapters read it again immediately before sending `sellGem`.
