# Model hosted swaps as refreshing workflows

The SDK will mirror the API's provider-neutral quote, including its conditional API Execution
Plan, but will expose only the currently safe Wallet Execution Plan through a discriminated
Hosted Swap Workflow. Callers may drive approval and provider-locked Quote Refresh transitions
manually or use a bounded high-level executor; both paths enforce quote expiry before broadcast,
and cross-chain Transfer Status remains a separate concern. This prevents a generic sequential
wallet adapter from executing stale swap calldata after an approval while preserving the exact
wire contract for diagnostics and forward compatibility.
