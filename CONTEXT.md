# Osero SDK

This context exposes Osero swap quoting and execution concepts to SDK consumers.

## Language

**Quote Provider**:
An external service that supplies an executable quote for a supported asset pair. Enso and
LI.FI are Quote Providers whose differences are normalized by the Osero API.
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

**Transfer Status**:
The normalized progress of a cross-chain execution after its source-chain transaction is
confirmed. Provider-native lifecycle values are Provider Details rather than Transfer Status.

**Hosted Swap Workflow**:
The provider-locked progression from an initial quote through any Approval Steps and Quote
Refreshes to source-chain execution. Cross-chain Transfer Status begins after this workflow.
_Avoid_: Execution Plan
