/**
 * Opt-out error telemetry for `@osero/client`.
 *
 * The SDK reports a curated subset of the typed errors it *returns* to callers
 * to Osero's Sentry project so that SDK bugs, hosted API contract drift, and
 * failed on-chain executions are visible without integrators filing reports.
 *
 * Design constraints:
 *
 * - **Never global.** The Sentry client is a private instance built from
 *   `@sentry/core`; it does not call `Sentry.init`, does not install global
 *   handlers, and does not touch a host application's own Sentry setup.
 * - **Never on the hot path.** `@sentry/core` is loaded with a dynamic import
 *   the first time an event qualifies, so disabled consumers never pay for it.
 * - **Never throws, never logs.** Every entry point swallows its own failures.
 * - **Boundary-only.** Errors are observed where they leave the public API
 *   ({@link observeResult}); internal retries and recovered failures are never
 *   reported, and one error object is reported at most once.
 * - **No secrets, no PII.** API keys, request headers, wallet addresses, and
 *   user identity are never attached. See {@link buildTelemetryEvent}.
 */
import type { ExecutionFailureContext, OseroErrorCode } from './errors.js';
import type { ResultAsync } from './result.js';
import { SDK_VERSION } from './version.js';

/** Public DSN of the `osero-kit` Sentry project. DSNs are not secrets. */
export const TELEMETRY_DSN =
  'https://efba268813d580a0fd18b9bb33f3b888@o4512046601404416.ingest.de.sentry.io/4512050183667792';

/** Hosts that receive the `sentry-trace` correlation header. */
const TRACE_HEADER_HOST_SUFFIX = 'osero.org';
/** Hard cap on outgoing events per process to keep retry loops from flooding. */
const EVENT_BUDGET = { limit: 30, windowMs: 60_000 } as const;

export type TelemetryConfig = {
  /**
   * Whether the SDK reports errors to Osero. Defaults to `true`. An explicit
   * value here overrides the `OSERO_TELEMETRY` and `DO_NOT_TRACK` environment
   * variables.
   */
  readonly enabled?: boolean;
};

export type TelemetryTrace = {
  readonly traceId: string;
  readonly spanId: string;
};

export type TelemetryLevel = 'error' | 'warning';

export type TelemetryOperationContext = {
  /** Public entry point that produced the error, e.g. `api.getSwapQuote`. */
  readonly operation: string;
  readonly executor?: string;
  readonly chainId?: number;
  readonly trace?: TelemetryTrace;
};

export type TelemetryEvent = {
  readonly error: Error;
  readonly level: TelemetryLevel;
  readonly tags: Readonly<Record<string, string | number | boolean>>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly fingerprint: readonly string[];
  readonly trace?: TelemetryTrace;
};

export type TelemetrySink = {
  capture(event: TelemetryEvent): void;
  flush(timeoutMs: number): Promise<boolean>;
};

type TelemetryState = {
  enabled: boolean | undefined;
  sink: Promise<TelemetrySink> | undefined;
  sinkFactory: (() => Promise<TelemetrySink>) | undefined;
  sentAt: number[];
};

const state: TelemetryState = {
  enabled: undefined,
  sink: undefined,
  sinkFactory: undefined,
  sentAt: [],
};

const reported = new WeakSet<object>();

/**
 * Configures SDK error telemetry for the whole process. Telemetry is on by
 * default; call `configureTelemetry({ enabled: false })` before using the SDK
 * to turn it off. Setting `OSERO_TELEMETRY=0` or `DO_NOT_TRACK=1` in the
 * environment has the same effect in Node.js.
 */
export function configureTelemetry(config: TelemetryConfig): void {
  if (typeof config !== 'object' || config === null) return;
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') return;
  state.enabled = config.enabled;
}

export function isTelemetryEnabled(): boolean {
  if (state.enabled !== undefined) return state.enabled;
  return !environmentOptsOut();
}

function environmentOptsOut(): boolean {
  const env = readEnvironment();
  if (env === undefined) return false;
  const telemetry = env['OSERO_TELEMETRY']?.trim().toLowerCase();
  if (telemetry !== undefined && ['0', 'false', 'off', 'no'].includes(telemetry)) return true;
  const doNotTrack = env['DO_NOT_TRACK']?.trim().toLowerCase();
  if (doNotTrack !== undefined && ['1', 'true', 'yes'].includes(doNotTrack)) return true;
  return env['NODE_ENV'] === 'test';
}

function readEnvironment(): Readonly<Record<string, string | undefined>> | undefined {
  try {
    const candidate = (globalThis as { process?: { env?: unknown } }).process?.env;
    return typeof candidate === 'object' && candidate !== null
      ? (candidate as Record<string, string | undefined>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts a trace for one public operation. Every hosted API request made on
 * behalf of that operation carries the trace id, and any error reported for
 * the operation is tagged with it, so SDK-side and API-side Sentry events can
 * be joined. Returns `undefined` when telemetry is off so no header is sent.
 */
export function startTelemetryTrace(): TelemetryTrace | undefined {
  if (!isTelemetryEnabled()) return undefined;
  return { traceId: randomHex(16), spanId: randomHex(8) };
}

/**
 * Headers that propagate {@link TelemetryTrace} to the hosted API. Only
 * Osero-operated hosts receive them so custom proxies never see an
 * unexpected header in their CORS preflight.
 */
export function telemetryTraceHeaders(
  trace: TelemetryTrace | undefined,
  url: URL,
): Readonly<Record<string, string>> {
  if (trace === undefined) return {};
  const host = url.hostname.toLowerCase();
  if (host !== TRACE_HEADER_HOST_SUFFIX && !host.endsWith(`.${TRACE_HEADER_HOST_SUFFIX}`)) {
    return {};
  }
  return { 'sentry-trace': `${trace.traceId}-${trace.spanId}` };
}

/**
 * Observes a public-boundary result and reports its error, if it qualifies,
 * without changing the result. Reporting is asynchronous and fire-and-forget.
 */
export function observeResult<T, E>(
  result: ResultAsync<T, E>,
  context: TelemetryOperationContext,
): ResultAsync<T, E> {
  return result.orTee((error) => reportError(error, context));
}

/** Reports one error. Safe to call with anything; non-qualifying values are ignored. */
export function reportError(error: unknown, context: TelemetryOperationContext): void {
  try {
    if (!isTelemetryEnabled()) return;
    if (typeof error !== 'object' || error === null) return;
    const level = classifyForTelemetry(error);
    if (level === undefined) return;
    if (reported.has(error)) return;
    reported.add(error);
    if (!takeEventBudget(Date.now())) return;
    const event = buildTelemetryEvent(error as OseroErrorLike, level, context);
    void deliver(event);
  } catch {
    // Telemetry must never affect the caller.
  }
}

async function deliver(event: TelemetryEvent): Promise<void> {
  try {
    const sink = await resolveSink();
    sink.capture(event);
  } catch {
    // Loading or sending failed; drop the event.
  }
}

function resolveSink(): Promise<TelemetrySink> {
  state.sink ??= (state.sinkFactory ?? createSentrySink)();
  return state.sink;
}

function takeEventBudget(now: number): boolean {
  state.sentAt = state.sentAt.filter((sent) => now - sent < EVENT_BUDGET.windowMs);
  if (state.sentAt.length >= EVENT_BUDGET.limit) return false;
  state.sentAt.push(now);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

type OseroErrorLike = Error & {
  readonly code: OseroErrorCode;
  readonly execution?: ExecutionFailureContext;
  readonly statusCode?: number;
  readonly apiCode?: string;
  readonly correlationId?: string;
  readonly url?: string;
  readonly method?: string;
  readonly retryAfterMs?: number;
  readonly txHash?: string;
  readonly chainId?: number;
  readonly operation?: string;
  toJSON?: () => Readonly<Record<string, unknown>>;
};

/**
 * Codes that are never reported: caller mistakes, user decisions, and
 * environment conditions the SDK cannot act on.
 */
const IGNORED_CODES: ReadonlySet<OseroErrorCode> = new Set<OseroErrorCode>([
  'VALIDATION_ERROR',
  'CONFIGURATION_ERROR',
  'UNSUPPORTED_CHAIN',
  'ACCOUNT_MISMATCH',
  'CHAIN_MISMATCH',
  'UNSUPPORTED_CAPABILITY',
  'CANCELLED',
  'SIGNING_FAILED',
  'QUOTE_EXPIRED',
  'TIMEOUT',
  'PROGRESS_CALLBACK_FAILED',
  'API_TRANSPORT_FAILED',
  'RPC_REQUEST_FAILED',
]);

const ERROR_CODES: ReadonlySet<OseroErrorCode> = new Set<OseroErrorCode>([
  'UNEXPECTED_ERROR',
  'API_RESPONSE_INVALID',
  'TRANSACTION_REVERTED',
]);

const WARNING_CODES: ReadonlySet<OseroErrorCode> = new Set<OseroErrorCode>([
  'SIMULATION_FAILED',
  'BROADCAST_FAILED',
  'CONFIRMATION_FAILED',
  'INSUFFICIENT_ALLOWANCE',
  'APPROVAL_LIMIT_EXCEEDED',
  'QUOTE_REFRESH_LIMIT_EXCEEDED',
]);

/** API statuses that reflect the caller's key, quota, or market, not the SDK. */
const IGNORED_API_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 429]);

const INSUFFICIENT_FUNDS = /insufficient funds|insufficient balance|exceeds (?:the )?balance/i;

/**
 * Decides whether an error is worth reporting and how loud it should be.
 * Exported for tests and documentation; not part of the public API.
 */
export function classifyForTelemetry(error: object): TelemetryLevel | undefined {
  if (!isOseroErrorLike(error)) return undefined;
  const { code } = error;
  if (IGNORED_CODES.has(code)) return undefined;
  if (code === 'API_REQUEST_FAILED') {
    const status = error.statusCode ?? 0;
    if (IGNORED_API_STATUSES.has(status)) return undefined;
    if (status >= 500) return 'error';
    return 'warning';
  }
  if (ERROR_CODES.has(code)) return 'error';
  if (WARNING_CODES.has(code)) {
    if (
      (code === 'SIMULATION_FAILED' || code === 'BROADCAST_FAILED') &&
      causeChainMatches(error, INSUFFICIENT_FUNDS)
    ) {
      return undefined;
    }
    return 'warning';
  }
  return undefined;
}

function isOseroErrorLike(error: object): error is OseroErrorLike {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof error.name === 'string'
  );
}

function causeChainMatches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && pattern.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Event shaping                                                              */
/* -------------------------------------------------------------------------- */

const MAX_DISCRIMINATOR_LENGTH = 120;

/**
 * Builds the payload sent to Sentry. Deliberately omits: API keys and
 * request headers, wallet addresses, token amounts, and anything about the
 * host application or machine.
 */
export function buildTelemetryEvent(
  error: OseroErrorLike,
  level: TelemetryLevel,
  context: TelemetryOperationContext,
): TelemetryEvent {
  const execution = error.execution;
  const chainId = context.chainId ?? error.chainId;
  const tags: Record<string, string | number | boolean> = {
    'osero.sdk_version': SDK_VERSION,
    'osero.operation': context.operation,
    'osero.error': error.name,
    'osero.error_code': error.code,
  };
  if (chainId !== undefined) tags['osero.chain_id'] = chainId;
  if (context.executor !== undefined) tags['osero.executor'] = context.executor;
  if (execution !== undefined) tags['osero.stage'] = execution.stage;
  if (error.statusCode !== undefined) tags['osero.api_status'] = error.statusCode;
  if (error.apiCode !== undefined) tags['osero.api_code'] = error.apiCode;
  if (error.correlationId !== undefined) tags['osero.correlation_id'] = error.correlationId;

  const osero: Record<string, unknown> = {
    operation: context.operation,
    sdkVersion: SDK_VERSION,
  };
  if (context.trace !== undefined) osero['traceId'] = context.trace.traceId;
  if (execution !== undefined) {
    osero['planId'] = execution.planId;
    osero['stepId'] = execution.stepId;
    osero['stepIndex'] = execution.stepIndex;
    osero['stepOperation'] = execution.operation;
    osero['stage'] = execution.stage;
    if (execution.hash !== undefined) osero['txHash'] = execution.hash;
    osero['completedHashes'] = execution.completed.map((step) => step.hash);
  } else if (error.txHash !== undefined) {
    osero['txHash'] = error.txHash;
  }
  if (error.url !== undefined || error.statusCode !== undefined) {
    osero['api'] = {
      ...(error.method === undefined ? {} : { method: error.method }),
      ...(error.url === undefined ? {} : { url: error.url }),
      ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
      ...(error.apiCode === undefined ? {} : { apiCode: error.apiCode }),
      ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }

  return {
    error,
    level,
    tags,
    context: osero,
    extra: { error: sanitizedErrorJson(error) },
    fingerprint: fingerprintFor(error, context),
    ...(context.trace === undefined ? {} : { trace: context.trace }),
  };
}

const EXTRA_OMITTED_FIELDS: ReadonlySet<string> = new Set([
  'headers',
  'cause',
  'stack',
  'plan',
  'approvalResults',
  'execution',
]);

function sanitizedErrorJson(error: OseroErrorLike): Readonly<Record<string, unknown>> {
  try {
    const json = typeof error.toJSON === 'function' ? error.toJSON() : {};
    return Object.fromEntries(
      Object.entries(json).filter(([key]) => !EXTRA_OMITTED_FIELDS.has(key)),
    );
  } catch {
    return { name: error.name, code: error.code, message: error.message };
  }
}

function fingerprintFor(error: OseroErrorLike, context: TelemetryOperationContext): string[] {
  const base = [error.name, context.operation];
  switch (error.code) {
    case 'UNEXPECTED_ERROR':
      return ['{{ default }}', ...base];
    case 'API_REQUEST_FAILED':
      return [...base, String(error.statusCode ?? 'unknown'), error.apiCode ?? 'none'];
    case 'API_RESPONSE_INVALID':
      return [...base, truncate(error.message)];
    default:
      if (error.execution !== undefined) {
        return [...base, error.execution.stage, error.execution.operation];
      }
      return [...base, truncate(error.message)];
  }
}

function truncate(value: string): string {
  return value.length > MAX_DISCRIMINATOR_LENGTH ? value.slice(0, MAX_DISCRIMINATOR_LENGTH) : value;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => void } })
    .crypto;
  if (typeof crypto?.getRandomValues === 'function') {
    crypto.getRandomValues(buffer);
  } else {
    for (let index = 0; index < buffer.length; index += 1) {
      buffer[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------------------------- */
/* Sentry sink                                                                */
/* -------------------------------------------------------------------------- */

type FetchLike = typeof globalThis.fetch;

type SentrySinkOptions = {
  readonly dsn?: string;
  readonly fetch?: FetchLike;
};

const KEEPALIVE_BODY_LIMIT = 60_000;

/**
 * Creates the private Sentry client. Loaded lazily so that consumers who
 * disable telemetry never download or evaluate `@sentry/core`.
 */
export async function createSentrySink(options: SentrySinkOptions = {}): Promise<TelemetrySink> {
  const sentry = await import('@sentry/core');
  const fetchImpl = options.fetch ?? resolveFetch();
  if (fetchImpl === undefined) throw new Error('No fetch implementation available');

  const client = new sentry.ServerRuntimeClient({
    dsn: options.dsn ?? TELEMETRY_DSN,
    release: `@osero/client@${SDK_VERSION}`,
    environment: detectEnvironment(),
    platform: 'javascript',
    runtime: detectRuntime(),
    transport: (transportOptions) =>
      sentry.createTransport(transportOptions, async (request) => {
        const body = request.body;
        const response = await fetchImpl(transportOptions.url, {
          method: 'POST',
          body,
          headers: transportOptions.headers,
          ...(typeof body === 'string' && body.length < KEEPALIVE_BODY_LIMIT
            ? { keepalive: true }
            : {}),
        });
        return {
          statusCode: response.status,
          headers: {
            'x-sentry-rate-limits': response.headers.get('X-Sentry-Rate-Limits'),
            'retry-after': response.headers.get('Retry-After'),
          },
        };
      }),
    stackParser: sentry.createStackParser(sentry.nodeStackLineParser()),
    integrations: [
      sentry.eventFiltersIntegration(),
      sentry.dedupeIntegration(),
      sentry.linkedErrorsIntegration({ limit: 5 }),
    ],
    sendClientReports: false,
    maxBreadcrumbs: 0,
    _metadata: {
      sdk: {
        name: 'sentry.javascript.core',
        version: sentry.SDK_VERSION,
        packages: [{ name: 'npm:@osero/client', version: SDK_VERSION }],
      },
    },
    beforeSend(event) {
      // Belt and braces: nothing about the user or their request ever leaves.
      delete event.user;
      delete event.request;
      delete event.server_name;
      delete event.breadcrumbs;
      return event;
    },
  });
  client.init();

  return {
    capture(event) {
      const scope = new sentry.Scope();
      scope.setClient(client);
      scope.setLevel(event.level);
      scope.setTags(event.tags);
      scope.setContext('osero', { ...event.context });
      scope.setExtras({ ...event.extra });
      scope.setFingerprint([...event.fingerprint]);
      if (event.trace !== undefined) {
        scope.setPropagationContext({
          traceId: event.trace.traceId,
          propagationSpanId: event.trace.spanId,
          sampleRand: Math.random(),
        });
      }
      // Capture through the scope (not the client) so Sentry records the
      // original exception and walks its `cause` chain.
      const mechanism = { type: 'osero.client', handled: true };
      scope.captureException(event.error, { mechanism, data: { mechanism } });
    },
    flush: (timeoutMs) => Promise.resolve(client.flush(timeoutMs)),
  };
}

function resolveFetch(): FetchLike | undefined {
  const candidate = globalThis.fetch;
  return typeof candidate === 'function' ? candidate.bind(globalThis) : undefined;
}

function detectEnvironment(): string {
  const nodeEnv = readEnvironment()?.['NODE_ENV'];
  return typeof nodeEnv === 'string' && nodeEnv.length > 0 ? nodeEnv : 'production';
}

function detectRuntime(): { name: string; version?: string } {
  const globals = globalThis as {
    Deno?: { version?: { deno?: string } };
    Bun?: { version?: string };
    process?: { versions?: { node?: string } };
    navigator?: { userAgent?: string };
  };
  if (globals.Deno !== undefined) return { name: 'deno', version: globals.Deno.version?.deno };
  if (globals.Bun !== undefined) return { name: 'bun', version: globals.Bun.version };
  const node = globals.process?.versions?.node;
  if (typeof node === 'string') return { name: 'node', version: node };
  if (typeof globals.navigator?.userAgent === 'string') return { name: 'browser' };
  return { name: 'unknown' };
}

/* -------------------------------------------------------------------------- */
/* Test hooks (not exported from any public entrypoint)                       */
/* -------------------------------------------------------------------------- */

export function _configureTelemetryForTesting(options: {
  readonly enabled?: boolean;
  readonly sink?: TelemetrySink | (() => Promise<TelemetrySink>);
}): void {
  state.enabled = options.enabled;
  state.sink = undefined;
  state.sentAt = [];
  if (options.sink === undefined) {
    state.sinkFactory = undefined;
  } else {
    const sink = options.sink;
    state.sinkFactory = typeof sink === 'function' ? sink : () => Promise.resolve(sink);
  }
}

export async function _flushTelemetryForTesting(timeoutMs = 2_000): Promise<boolean> {
  if (state.sink === undefined) return true;
  const sink = await state.sink;
  return sink.flush(timeoutMs);
}
