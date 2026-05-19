---
'@osero/client': patch
---

Add configurable PSM and token address overrides for contract migrations before the SDK's default registries are updated. Overrides are normalized and validated with viem's `getAddress` when the client is created.

Actions and previews now perform `eth_getCode` checks for configured PSM, Lite PSM, and sUSDS vault targets before building calldata or reading quotes. These checks fail early when an override points at an address without deployed bytecode and add one or more read RPCs to affected calls.
