---
'@osero/client': minor
---

Apply a built-in `DEFAULT_REFERRAL_CODE` (`3000n`) to every action whenever the request does not specify one, add a new `ClientConfig.defaultReferralCode` field to override or opt out at the client level, and treat `referralCode: undefined` on a request as a per-call opt-out. Upgrading without further action will emit `3000n` where calls previously emitted `0n` on PSM3 `Swap` events and the sUSDS `deposit` referral overload.
