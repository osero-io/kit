---
'@osero/client': patch
---

Guard Ethereum mainnet `mintUsds` execution against Lite PSM `tin` increases before `sellGem` is broadcast. Mainnet plans now read `tin()` once while building the guarded transaction and SDK adapters read it again immediately before sending `sellGem`. Because `sellGem` has no on-chain `minOut`, same-block fee changes after the preflight read remain possible and require a wrapper contract to eliminate completely.
