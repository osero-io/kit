import { vi } from 'vitest';

import { OseroApiClient, type OseroApiFetch } from './api.js';
import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  BroadcastError,
  CancelError,
  ConfigurationError,
  ConfirmationError,
  InsufficientAllowanceError,
  QuoteRefreshLimitError,
  RpcError,
  SimulationError,
  TimeoutError,
  TransactionError,
  UnexpectedError,
  UnsupportedChainError,
  ValidationError,
  type ExecutionFailureContext,
} from './errors.js';
import { errAsync, okAsync } from './result.js';
import {
  _configureTelemetryForTesting,
  _flushTelemetryForTesting,
  buildTelemetryEvent,
  classifyForTelemetry,
  configureTelemetry,
  createSentrySink,
  isTelemetryEnabled,
  observeResult,
  reportError,
  startTelemetryTrace,
  telemetryTraceHeaders,
  TELEMETRY_DSN,
  type TelemetryEvent,
  type TelemetrySink,
} from './telemetry.js';
import { SDK_VERSION } from './version.js';

const EXECUTION: ExecutionFailureContext = {
  planId: 'plan-1',
  stepId: 'swap',
  stepIndex: 1,
  operation: 'SWAP_EXACT_IN',
  stage: 'revert',
  hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  completed: [
    {
      planId: 'plan-1',
      stepId: 'approve',
      stepIndex: 0,
      operation: 'ERC20_APPROVE',
      hash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    },
  ],
};

function apiRequestError(statusCode: number, apiCode?: string): ApiRequestError {
  return new ApiRequestError({
    url: 'https://api.osero.org/v1/swap/quote',
    method: 'POST',
    statusCode,
    statusText: 'status',
    body: { code: apiCode, message: 'nope' },
    headers: { 'x-api-key': 'must-not-leak', 'x-correlation-id': 'corr-1' },
    ...(apiCode === undefined ? {} : { apiCode }),
    correlationId: 'corr-1',
    retryAfterMs: 1_000,
  });
}

function fakeSink(): TelemetrySink & { readonly events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  return {
    events,
    capture: (event) => {
      events.push(event);
    },
    flush: async () => true,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fetchReturning(status: number, body: unknown): OseroApiFetch & { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-9' },
    });
  }) as OseroApiFetch & { calls: RequestInit[] };
  impl.calls = calls;
  return impl;
}

type Envelope = {
  readonly header: Record<string, unknown>;
  readonly itemHeader: Record<string, unknown>;
  readonly event: Record<string, any>;
};

function parseEnvelope(body: unknown): Envelope {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array);
  const [header, itemHeader, event] = text.split('\n');
  return {
    header: JSON.parse(header!),
    itemHeader: JSON.parse(itemHeader!),
    event: JSON.parse(event!),
  };
}

afterEach(() => {
  _configureTelemetryForTesting({ enabled: undefined });
  vi.unstubAllEnvs();
});

describe('telemetry configuration', () => {
  it('is on by default outside test environments', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OSERO_TELEMETRY', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('is off while NODE_ENV is test', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(isTelemetryEnabled()).toBe(false);
  });

  it.each(['0', 'false', 'off', 'NO'])('honours OSERO_TELEMETRY=%s', (value) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OSERO_TELEMETRY', value);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'yes'])('honours DO_NOT_TRACK=%s', (value) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DO_NOT_TRACK', value);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('lets configureTelemetry override the environment in both directions', () => {
    vi.stubEnv('NODE_ENV', 'test');
    configureTelemetry({ enabled: true });
    expect(isTelemetryEnabled()).toBe(true);

    vi.stubEnv('NODE_ENV', 'production');
    configureTelemetry({ enabled: false });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('ignores malformed configuration instead of throwing', () => {
    configureTelemetry({ enabled: false });
    configureTelemetry(null as unknown as { enabled: boolean });
    configureTelemetry({ enabled: 'yes' as unknown as boolean });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('only starts traces and emits headers while enabled', () => {
    configureTelemetry({ enabled: false });
    expect(startTelemetryTrace()).toBeUndefined();

    configureTelemetry({ enabled: true });
    const trace = startTelemetryTrace();
    expect(trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(telemetryTraceHeaders(trace, new URL('https://api.osero.org/v1/swap/quote'))).toEqual({
      'sentry-trace': `${trace!.traceId}-${trace!.spanId}`,
    });
    expect(telemetryTraceHeaders(trace, new URL('https://osero.org/x'))).toHaveProperty(
      'sentry-trace',
    );
    expect(telemetryTraceHeaders(trace, new URL('https://proxy.example.com/v1/'))).toEqual({});
    expect(telemetryTraceHeaders(trace, new URL('https://notosero.org/v1/'))).toEqual({});
    expect(telemetryTraceHeaders(undefined, new URL('https://api.osero.org/'))).toEqual({});
  });
});

describe('classifyForTelemetry', () => {
  it.each([
    ['ValidationError', ValidationError.forField('x', 'bad')],
    ['ConfigurationError', new ConfigurationError('bad')],
    ['UnsupportedChainError', new UnsupportedChainError(5)],
    ['CancelError', CancelError.from(new Error('user rejected'))],
    ['TimeoutError', new TimeoutError('op', 10)],
    ['ApiTransportError', ApiTransportError.from(new Error('offline'), 'u', 'GET')],
    ['RpcError', RpcError.from({ cause: new Error('rpc'), operation: 'call', chainId: 1 })],
    ['ApiRequestError 401', apiRequestError(401, 'UNAUTHORIZED')],
    ['ApiRequestError 403', apiRequestError(403)],
    ['ApiRequestError 404', apiRequestError(404, 'QUOTE_UNAVAILABLE')],
    ['ApiRequestError 429', apiRequestError(429, 'RATE_LIMITED')],
    [
      'SimulationError from insufficient funds',
      SimulationError.from(new Error('insufficient funds for gas * price + value')),
    ],
    [
      'BroadcastError from nested insufficient balance',
      BroadcastError.from(
        new Error('execution failed', {
          cause: new Error('ERC20: transfer amount exceeds balance'),
        }),
      ),
    ],
    ['plain Error', new Error('not an SDK error')],
  ])('ignores %s', (_label, error) => {
    expect(classifyForTelemetry(error)).toBeUndefined();
  });

  it.each([
    ['UnexpectedError', UnexpectedError.from(new TypeError('boom'))],
    ['ApiResponseError', ApiResponseError.from(new Error('$.quote missing'), 'u', 'POST')],
    ['ApiRequestError 500', apiRequestError(500, 'INTERNAL_ERROR')],
    ['ApiRequestError 503', apiRequestError(503)],
    ['TransactionError', new TransactionError('reverted', EXECUTION.hash!, EXECUTION)],
  ])('reports %s as error', (_label, error) => {
    expect(classifyForTelemetry(error)).toBe('error');
  });

  it.each([
    ['ApiRequestError 400', apiRequestError(400, 'INVALID_REQUEST')],
    ['SimulationError', SimulationError.from(new Error('execution reverted'))],
    ['BroadcastError', BroadcastError.from(new Error('nonce too low'))],
    ['ConfirmationError', ConfirmationError.from(new Error('receipt lost'), EXECUTION)],
    [
      'InsufficientAllowanceError',
      new InsufficientAllowanceError(
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        10n,
        1n,
      ),
    ],
    ['QuoteRefreshLimitError', new QuoteRefreshLimitError(5, [])],
  ])('reports %s as warning', (_label, error) => {
    expect(classifyForTelemetry(error)).toBe('warning');
  });

  it('tolerates cyclic cause chains', () => {
    const inner = new Error('loop');
    const outer = new Error('outer', { cause: inner });
    (inner as { cause?: unknown }).cause = outer;
    expect(classifyForTelemetry(SimulationError.from(outer))).toBe('warning');
  });
});

describe('buildTelemetryEvent', () => {
  it('describes execution failures without wallet data', () => {
    const error = new TransactionError('reverted', EXECUTION.hash!, EXECUTION);
    const trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    const event = buildTelemetryEvent(error, 'error', {
      operation: 'viem.sendWith',
      executor: 'viem',
      chainId: 8453,
      trace,
    });

    expect(event.level).toBe('error');
    expect(event.trace).toEqual(trace);
    expect(event.tags).toEqual({
      'osero.sdk_version': SDK_VERSION,
      'osero.operation': 'viem.sendWith',
      'osero.error': 'TransactionError',
      'osero.error_code': 'TRANSACTION_REVERTED',
      'osero.chain_id': 8453,
      'osero.executor': 'viem',
      'osero.stage': 'revert',
    });
    expect(event.context).toEqual({
      operation: 'viem.sendWith',
      sdkVersion: SDK_VERSION,
      traceId: trace.traceId,
      planId: 'plan-1',
      stepId: 'swap',
      stepIndex: 1,
      stepOperation: 'SWAP_EXACT_IN',
      stage: 'revert',
      txHash: EXECUTION.hash,
      completedHashes: [EXECUTION.completed[0]!.hash],
    });
    expect(event.fingerprint).toEqual([
      'TransactionError',
      'viem.sendWith',
      'revert',
      'SWAP_EXACT_IN',
    ]);
    expect(event.extra['error']).not.toHaveProperty('execution');
    expect(event.extra['error']).toMatchObject({ txHash: EXECUTION.hash });
  });

  it('describes API failures without headers or keys', () => {
    const error = apiRequestError(502, 'INTERNAL_ERROR');
    const event = buildTelemetryEvent(error, 'error', { operation: 'api.getSwapQuote' });

    expect(event.tags).toMatchObject({
      'osero.api_status': 502,
      'osero.api_code': 'INTERNAL_ERROR',
      'osero.correlation_id': 'corr-1',
    });
    expect(event.context['api']).toEqual({
      method: 'POST',
      url: 'https://api.osero.org/v1/swap/quote',
      statusCode: 502,
      apiCode: 'INTERNAL_ERROR',
      correlationId: 'corr-1',
      retryAfterMs: 1_000,
    });
    expect(event.fingerprint).toEqual([
      'ApiRequestError',
      'api.getSwapQuote',
      '502',
      'INTERNAL_ERROR',
    ]);
    const { error: _error, ...serializable } = event;
    expect(JSON.stringify(serializable)).not.toContain('must-not-leak');
    expect(event.extra['error']).not.toHaveProperty('headers');
    expect(event.extra['error']).not.toHaveProperty('cause');
  });

  it('uses default grouping for unexpected errors and chain ids from RPC errors', () => {
    const unexpected = buildTelemetryEvent(UnexpectedError.from(new Error('x')), 'error', {
      operation: 'actions.prepareSwap',
    });
    expect(unexpected.fingerprint).toEqual([
      '{{ default }}',
      'UnexpectedError',
      'actions.prepareSwap',
    ]);

    const response = buildTelemetryEvent(
      ApiResponseError.from(new Error('m'.repeat(200)), 'u', 'GET'),
      'error',
      { operation: 'api.getSwapStatus' },
    );
    expect(response.fingerprint[2]).toHaveLength(120);

    const rpc = RpcError.from({ cause: new Error('rpc'), operation: 'call', chainId: 10 });
    const withChain = buildTelemetryEvent(rpc, 'warning', { operation: 'x' });
    expect(withChain.tags['osero.chain_id']).toBe(10);
  });

  it('falls back when toJSON throws', () => {
    const error = UnexpectedError.from(new Error('x'));
    Object.defineProperty(error, 'toJSON', {
      value: () => {
        throw new Error('nope');
      },
    });
    const event = buildTelemetryEvent(error, 'error', { operation: 'x' });
    expect(event.extra['error']).toEqual({
      name: 'UnexpectedError',
      code: 'UNEXPECTED_ERROR',
      message: 'x',
    });
  });
});

describe('observeResult', () => {
  it('reports qualifying errors once and leaves the result untouched', async () => {
    const sink = fakeSink();
    _configureTelemetryForTesting({ enabled: true, sink });
    const error = ApiResponseError.from(new Error('drift'), 'u', 'GET');

    const first = await observeResult(errAsync(error), { operation: 'api.getSwapQuote' });
    const second = await observeResult(errAsync(error), { operation: 'api.executeSwap' });
    await settle();

    expect(first.isErr() && first.error).toBe(error);
    expect(second.isErr() && second.error).toBe(error);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.tags['osero.operation']).toBe('api.getSwapQuote');
  });

  it('passes successes and ignored errors through without reporting', async () => {
    const sink = fakeSink();
    _configureTelemetryForTesting({ enabled: true, sink });

    const success = await observeResult(okAsync(42), { operation: 'x' });
    const ignored = await observeResult(errAsync(ValidationError.forField('f', 'bad')), {
      operation: 'x',
    });
    await settle();

    expect(success.isOk() && success.value).toBe(42);
    expect(ignored.isErr()).toBe(true);
    expect(sink.events).toHaveLength(0);
  });

  it('does nothing while disabled', async () => {
    const sink = fakeSink();
    _configureTelemetryForTesting({ enabled: false, sink });
    await observeResult(errAsync(UnexpectedError.from(new Error('x'))), { operation: 'x' });
    await settle();
    expect(sink.events).toHaveLength(0);
  });

  it('never lets sink failures reach the caller', async () => {
    _configureTelemetryForTesting({
      enabled: true,
      sink: () => Promise.reject(new Error('sentry unavailable')),
    });
    const result = await observeResult(errAsync(UnexpectedError.from(new Error('x'))), {
      operation: 'x',
    });
    await settle();
    expect(result.isErr()).toBe(true);

    _configureTelemetryForTesting({
      enabled: true,
      sink: {
        capture: () => {
          throw new Error('capture exploded');
        },
        flush: async () => true,
      },
    });
    const again = await observeResult(errAsync(UnexpectedError.from(new Error('y'))), {
      operation: 'x',
    });
    await settle();
    expect(again.isErr()).toBe(true);
  });

  it('caps the number of events per window', async () => {
    const sink = fakeSink();
    _configureTelemetryForTesting({ enabled: true, sink });
    for (let index = 0; index < 40; index += 1) {
      reportError(UnexpectedError.from(new Error(`e${index}`)), { operation: 'x' });
    }
    await settle();
    expect(sink.events).toHaveLength(30);
  });

  it('ignores non-object and non-SDK inputs', async () => {
    const sink = fakeSink();
    _configureTelemetryForTesting({ enabled: true, sink });
    reportError('string', { operation: 'x' });
    reportError(null, { operation: 'x' });
    reportError(new Error('plain'), { operation: 'x' });
    await settle();
    expect(sink.events).toHaveLength(0);
  });
});

describe('hosted API integration', () => {
  it('sends a sentry-trace header and links reported API errors to it', async () => {
    const sink = fakeSink();
    _configureTelemetryForTesting({ enabled: true, sink });
    const fetch = fetchReturning(500, { code: 'INTERNAL_ERROR', message: 'down' });
    const client = OseroApiClient.create({ apiKey: 'osero_key', fetch });

    const result = await client.getSupportedAssets();
    await settle();

    const header = new Headers(fetch.calls[0]?.headers).get('sentry-trace');
    expect(header).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}$/);
    expect(result.isErr() && result.error).toBeInstanceOf(ApiRequestError);
    expect(sink.events).toHaveLength(1);
    const [event] = sink.events;
    expect(event?.tags).toMatchObject({
      'osero.operation': 'api.getSupportedAssets',
      'osero.api_status': 500,
      'osero.api_code': 'INTERNAL_ERROR',
      'osero.correlation_id': 'req-9',
    });
    expect(event?.trace?.traceId).toBe(header?.split('-')[0]);
    expect(JSON.stringify(event)).not.toContain('osero_key');
  });

  it('omits the header while disabled and for non-Osero hosts', async () => {
    _configureTelemetryForTesting({ enabled: false });
    const disabled = fetchReturning(200, { assets: [] });
    await OseroApiClient.create({ apiKey: 'osero_key', fetch: disabled }).getSupportedAssets();
    expect(new Headers(disabled.calls[0]?.headers).has('sentry-trace')).toBe(false);

    _configureTelemetryForTesting({ enabled: true, sink: fakeSink() });
    const proxied = fetchReturning(200, { assets: [] });
    await OseroApiClient.create({
      apiKey: 'osero_key',
      fetch: proxied,
      baseUrl: 'https://proxy.example.com/osero/',
    }).getSupportedAssets();
    expect(new Headers(proxied.calls[0]?.headers).has('sentry-trace')).toBe(false);
  });

  it('stays quiet for caller-side API failures', async () => {
    const sink = fakeSink();
    _configureTelemetryForTesting({ enabled: true, sink });
    const fetch = fetchReturning(401, { code: 'UNAUTHORIZED', message: 'bad key' });
    await OseroApiClient.create({ apiKey: 'osero_key', fetch }).getSupportedAssets();
    await settle();
    expect(sink.events).toHaveLength(0);
  });
});

describe('Sentry sink', () => {
  it('posts a scrubbed envelope to the Osero project without global side effects', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input.toString(), init: init ?? {} });
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;
    _configureTelemetryForTesting({ enabled: true, sink: () => createSentrySink({ fetch }) });
    vi.stubEnv('NODE_ENV', 'staging');

    const trace = startTelemetryTrace()!;
    const cause = new RangeError('inner failure');
    reportError(UnexpectedError.from(cause), {
      operation: 'actions.prepareSwap',
      chainId: 1,
      trace,
    });
    await settle();
    expect(await _flushTelemetryForTesting()).toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toMatch(
      /^https:\/\/o4512046601404416\.ingest\.de\.sentry\.io\/api\/4512050183667792\/envelope\//,
    );
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init).toMatchObject({ keepalive: true });

    const { header, itemHeader, event } = parseEnvelope(requests[0]?.init.body);
    expect(header['sent_at']).toEqual(expect.any(String));
    expect(requests[0]?.url).toContain(`sentry_key=${new URL(TELEMETRY_DSN).username}`);
    expect(itemHeader['type']).toBe('event');
    expect(event['level']).toBe('error');
    expect(event['platform']).toBe('javascript');
    expect(event['release']).toBe(`@osero/client@${SDK_VERSION}`);
    expect(event['environment']).toBe('staging');
    expect(event['sdk']['packages']).toContainEqual({
      name: 'npm:@osero/client',
      version: SDK_VERSION,
    });
    expect(event['contexts']['runtime']['name']).toBe('node');
    expect(event['contexts']['trace']['trace_id']).toBe(trace.traceId);
    expect(event['contexts']['osero']).toMatchObject({ operation: 'actions.prepareSwap' });
    expect(event['tags']).toMatchObject({
      'osero.operation': 'actions.prepareSwap',
      'osero.chain_id': 1,
      'osero.error_code': 'UNEXPECTED_ERROR',
    });
    expect(event['fingerprint']).toEqual([
      '{{ default }}',
      'UnexpectedError',
      'actions.prepareSwap',
    ]);
    const types = event['exception']['values'].map((value: { type: string }) => value.type);
    expect(types).toEqual(expect.arrayContaining(['UnexpectedError', 'RangeError']));
    expect(event['exception']['values'].at(-1)?.mechanism).toMatchObject({
      type: 'osero.client',
      handled: true,
    });
    expect(event).not.toHaveProperty('user');
    expect(event).not.toHaveProperty('request');
    expect(event).not.toHaveProperty('server_name');
    expect(event).not.toHaveProperty('breadcrumbs');
  });

  it('never serialises response headers of API errors', async () => {
    const bodies: string[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;
    _configureTelemetryForTesting({ enabled: true, sink: () => createSentrySink({ fetch }) });

    reportError(apiRequestError(500, 'INTERNAL_ERROR'), { operation: 'api.getSwapQuote' });
    await settle();
    await _flushTelemetryForTesting();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('INTERNAL_ERROR');
    expect(bodies[0]).not.toContain('must-not-leak');
    const { event } = parseEnvelope(bodies[0]);
    expect(event['level']).toBe('error');
    expect(event['tags']['osero.api_status']).toBe(500);
  });

  it('feeds Sentry rate-limit headers back to the transport', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response('', {
        status: 429,
        headers: { 'X-Sentry-Rate-Limits': '3600:error:organization', 'Retry-After': '3600' },
      });
    }) as typeof globalThis.fetch;
    _configureTelemetryForTesting({ enabled: true, sink: () => createSentrySink({ fetch }) });

    reportError(UnexpectedError.from(new Error('one')), { operation: 'x' });
    await settle();
    await _flushTelemetryForTesting();
    reportError(UnexpectedError.from(new Error('two')), { operation: 'x' });
    await settle();
    await _flushTelemetryForTesting();

    expect(calls).toBe(1);
  });

  it('flushes trivially before the sink exists', async () => {
    _configureTelemetryForTesting({ enabled: true });
    expect(await _flushTelemetryForTesting()).toBe(true);
  });
});
