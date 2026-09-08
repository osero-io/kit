# Error telemetry

`@osero/client` reports a small, fixed set of its own failures to Osero so that SDK bugs, hosted API
contract drift, and failed on-chain executions are caught without integrators having to file
reports. Telemetry is **on by default** and can be turned off at any time.

## What is reported

Only errors that the SDK **returns to your code** from a public entry point are considered. Errors
that the SDK retries or recovers from internally are never sent, and one error object is reported at
most once, even when it passes through several SDK layers.

| Reported as `error`                            | Reported as `warning`                                           | Never reported                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnexpectedError` (an SDK bug)                 | `ApiRequestError` with a 4xx status other than the ones ignored | `ValidationError`, `ConfigurationError`, `UnsupportedChainError`, `AccountMismatchError`, `ChainMismatchError`, `UnsupportedCapabilityError` (caller mistakes) |
| `ApiResponseError` (hosted API contract drift) | `SimulationError`, `BroadcastError`, `ConfirmationError`        | `CancelError`, `SigningError` (user or wallet decisions)                                                                                                       |
| `ApiRequestError` with a 5xx status            | `InsufficientAllowanceError`                                    | `ApiRequestError` with status 401, 403, 404, or 429 (key, quota, or market conditions)                                                                         |
| `TransactionError` (an on-chain revert)        | `ApprovalLimitError`, `QuoteRefreshLimitError`                  | `ApiTransportError`, `RpcError`, `TimeoutError`, `QuoteExpiredError`, `ProgressCallbackError` (environment conditions)                                         |

`SimulationError` and `BroadcastError` whose cause mentions insufficient funds or balance are also
ignored: they describe the wallet, not the SDK.

A process sends at most 30 events per minute. Sentry's own rate limits are honoured.

## What each event contains

- The error class, code, and message, with the chain of `cause` errors and their stack traces.
- The SDK version, the runtime (`node`, `browser`, `bun`, `deno`) and, in Node.js, its version.
- The public operation that failed, such as `api.getSwapQuote` or `viem.sendWith`, the executor,
  and the chain id.
- For execution failures: the plan id, step id and index, the step operation, the stage, and the
  transaction hashes involved.
- For hosted API failures: the request method and URL, the status code, the API error code, the
  correlation id, and the error body returned by the API.

## What is never sent

- API keys, request headers, or response headers.
- Wallet addresses, token amounts, or approval sizes.
- User identity, IP addresses, cookies, or anything about the host application or machine.

Sentry's `sendDefaultPii` stays off, and every event is scrubbed of `user`, `request`, and
`server_name` before it leaves the process.

## Turning it off

Call `configureTelemetry` once, before using the SDK:

```ts
import { configureTelemetry } from '@osero/client';

configureTelemetry({ enabled: false });
```

In Node.js, either environment variable has the same effect without a code change:

```sh
OSERO_TELEMETRY=0
DO_NOT_TRACK=1
```

Telemetry is also off automatically while `NODE_ENV=test`. An explicit `configureTelemetry` call
overrides the environment in both directions.

## Isolation from your own Sentry setup

The SDK never calls `Sentry.init`, installs no global handlers, and does not read or write the
global Sentry scope. It builds a private client from `@sentry/core` with its own transport the first
time an event qualifies; consumers that disable telemetry never load that module.

## Hosted API correlation

Requests to `api.osero.org` (and other `*.osero.org` hosts) carry a `sentry-trace` header holding a
trace id that is created per public operation, so every request made by one `executeSwap` call
shares a single trace. Any SDK-side event for that operation carries the same trace id, and the
hosted API can continue the trace on its side to link both projects' events. Custom `baseUrl`
proxies never receive the header.
