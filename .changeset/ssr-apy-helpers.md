---
'@osero/client': minor
---

Add SSR / sUSDS APY read helpers. New exports `getSsr`, `getSUsdsApy`, and the pure `ssrToApy` converter return the current Sky Savings Rate as a RAY-scaled `bigint` and as an annualised decimal fraction. Mainnet reads `ssr()` directly off the sUSDS vault; L2s read `getSSR()` off Spark's `SSRAuthOracle`. Also exports the `RAY` and `SECONDS_PER_YEAR` constants and the `ssrAbi` ABI used by both reads.
