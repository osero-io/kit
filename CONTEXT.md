# Osero SDK

This context exposes Osero swap quoting and execution concepts to SDK consumers.

## Language

**Quote Provider**:
An external service that supplies an executable quote for a supported asset pair. Enso, LI.FI,
and 0x are Quote Providers whose differences are normalized by the Osero API. 0x is one Quote
Provider even though it spans a same-chain and a cross-chain upstream API.
_Avoid_: Aggregator

**Provider Details**:
Quote Provider-specific facts used for attribution and diagnostics. Unknown Provider Details do
not change the meaning or safety of the provider-neutral quote lifecycle.
_Avoid_: Raw provider response

**Approval Step**:
A conditional source-chain action that authorizes a Quote Provider's spender when the current
allowance is insufficient. Completing one invalidates the remainder of the quoted actions.
_Avoid_: Required approval transaction

**Quote Refresh**:
A replacement quote from the already-selected Quote Provider after an approval or expiry. It
does not repeat provider selection.
_Avoid_: Requote, provider selection

**API Execution Plan**:
The conditional set of Approval Steps and final execution action returned with a quote. It
describes the full quoted lifecycle but is not necessarily safe to submit sequentially.

**Wallet Execution Plan**:
The actions that are currently safe for a wallet to submit sequentially without an intervening
Quote Refresh.
_Avoid_: API Execution Plan

**Status Context**:
The provider-discriminated set of fields a quote issues for polling its Transfer Status. It is
persisted with the quote and submitted unchanged; a 0x context also carries the Provider Quote
ID.
_Avoid_: Status request params

**Provider Quote ID**:
The Quote Provider's own identifier for a quote, required when polling 0x cross-chain status
because bundled transactions cannot otherwise be disambiguated.

**Transfer Status**:
The normalized progress of a cross-chain execution after its source-chain transaction is
confirmed. Provider-native lifecycle values are Provider Details rather than Transfer Status.

**Recovery Context**:
The normalized guidance attached to a failed Transfer Status describing whether funds are being
recovered automatically, are already recovered, need a manual Recovery Action, were never at
risk, or cannot be recovered.
_Avoid_: Refund status

**Recovery Action**:
A sender-free transaction that recovers funds from a failed cross-chain transfer. Any caller may
submit it, and Osero never signs or submits one.
_Avoid_: Refund transaction

**Hosted Swap Workflow**:
The provider-locked progression from an initial quote through any Approval Steps and Quote
Refreshes to source-chain execution. Cross-chain Transfer Status begins after this workflow.
_Avoid_: Execution Plan
