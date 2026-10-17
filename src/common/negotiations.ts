/**
 * Shared protocol types, the contract-first API (defineContract/svc/act),
 * typed-proxy type helpers, and small utilities shared by client and server.
 * Extracted verbatim from the former single-file protocol.ts (v1.8).
 */
export type JsonRecord = Record<string, unknown>;

export interface ClientCallRequest {
  url: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  data?: unknown;
  headers?: Record<string, string>;
  /** Cancels the whole logical call (HTTP requests and in-flight client services). */
  signal?: AbortSignal;
  /** Overrides NegotiationClientOptions.maxRounds for this call. */
  maxRounds?: number;
}

export interface ServerRequest {
  jobId: string;
  method: string;
  path: string;
  origin: string;
  params: Record<string, unknown>;
  data: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface ClientAction {
  name: string;
  data: unknown;
  /**
   * Correlation ID matching this action to its `ActionResult`. The name is
   * kept for wire compatibility — it is not an external-callback ID.
   */
  callbackID: string;
}

/** Public action descriptor; callback IDs are generated inside Server.require(). */
export interface ClientServiceRequest {
  name: string;
  data?: unknown;
  /** Value to use if this optional client service fails. */
  fallback?: unknown;
}

export type ActionResult =
  | { callbackID: string; ok: true; result: unknown }
  | {
      callbackID: string;
      ok: false;
      error: { code: string; message: string };
    };

export interface NegotiationResponse {
  protocol: 1;
  jobId: string;
  round: number;
  done: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  actions: ClientAction[];
  resumeUrl?: string;
  resumeToken?: string;
}

export interface HttpPluginRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
  phase: "initial" | "resume";
}

export interface HttpPluginResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  phase: "initial" | "resume";
}

export interface ClientPlugin {
  /**
   * Runs (awaited, in registration order) before every HTTP round. Mutate
   * the request in place, return a replacement request, or halt the chain:
   * return `false` (or throw / call `haltRequest()`) to stop the request
   * before fetch with a `REQUEST_HALTED` error, which is also routed
   * through `onError`.
   */
  onRequest?: (
    request: HttpPluginRequest,
  ) => void | false | HttpPluginRequest | Promise<void | false | HttpPluginRequest>;
  onResponse?: (
    body: unknown,
    response: HttpPluginResponse,
  ) => void | unknown | Promise<void | unknown>;
  onError?: (error: Error, request: HttpPluginRequest) => void | Promise<void>;
}

/** Error used when a client plugin halts a request before it is sent. */
export class RequestHaltedError extends Error {
  readonly code = "REQUEST_HALTED";

  constructor(message = "Request halted by a client plugin") {
    super(message);
    this.name = "RequestHaltedError";
  }
}

/**
 * Halt the client plugin chain from inside an `onRequest` hook: the request
 * is never sent, remaining plugins are skipped, `onError` hooks observe the
 * error, and `client.call()` rejects with it. (Returning `false` from
 * `onRequest` is the shorthand for `haltRequest()`.)
 */
export function haltRequest(message?: string): never {
  throw new RequestHaltedError(message);
}

/** Call-scoped information passed to every `ServerPlugin` hook. */
export interface ServerPluginCall {
  jobId: string;
  path: string;
  method: string;
  origin: string;
  /** Current negotiation round (0 before the first round is issued). */
  round: number;
  startedAt: string;
  request: ServerRequest;
}

/** @deprecated Use `ServerPluginCall`. */
export type ServerPluginJob = ServerPluginCall;

/**
 * Passed to `onRound`: a negotiation round was issued. Deliberately carries
 * NO ask details: plugins cannot observe (or intercept) asks/responseAsks —
 * neither the asked service names nor their data appear here.
 */
export type ServerPluginCallRound = ServerPluginCall;

/** @deprecated Use `ServerPluginCallRound`. */
export type ServerPluginRound = ServerPluginCallRound;

/** Passed to `onCallEnd`: the call finished successfully with this final result. */
export interface ServerPluginCallResult extends ServerPluginCall {
  result: unknown;
}

/** @deprecated Use `ServerPluginCallResult`. */
export type ServerPluginResult = ServerPluginCallResult;

/** Passed to `onCallError`: the call failed with this error. */
export interface ServerPluginCallError extends ServerPluginCall {
  error: Error;
}

/** @deprecated Use `ServerPluginCallError`. */
export type ServerPluginError = ServerPluginCallError;

/**
 * Return this from an `onCallStart` hook to handle the call yourself: the
 * remaining `onCallStart` plugins and the route handler are skipped, and the
 * call ends with `result` through the normal end path (onCallEnd plugins
 * `onCallEnd` hooks still run). Create it with `handledResult(result)`.
 */
export interface ServerPluginHandled {
  handled: true;
  result?: unknown;
}

/** Short-circuit helper for `onCallStart`: `return handledResult({ ... })`. */
export function handledResult(result?: unknown): ServerPluginHandled {
  return { handled: true, result };
}

/**
 * Server-side plugin: lifecycle hooks for calls, registered with
 * `NegotiationServer.plugin()`. Hooks run in registration order and are
 * awaited. Throwing from `onCallStart`/`onRound` fails the call (the error is
 * delivered to the client and `onCallError` fires); throwing from
 * `onCallEnd`/`onCallError` is only reported through the server's `onError`
 * option and never changes the job's outcome.
 */
export interface ServerPlugin {
  /** Optional label, handy when logging from inside hooks. */
  name?: string;
  /**
   * May return `handledResult(result)` to answer the call itself:
   * remaining `onCallStart` plugins and the route handler are skipped.
   */
  onCallStart?: (
    call: ServerPluginCall,
  ) => void | ServerPluginHandled | Promise<void | ServerPluginHandled>;
  onRound?: (round: ServerPluginCallRound) => void | Promise<void>;
  onCallEnd?: (call: ServerPluginCallResult) => void | Promise<void>;
  onCallError?: (call: ServerPluginCallError) => void | Promise<void>;
  /** @deprecated Use `onCallStart`. Kept as a working alias. */
  onNegotiationStart?: ServerPlugin["onCallStart"];
  /** @deprecated Use `onCallEnd`. Kept as a working alias. */
  onNegotiationEnd?: ServerPlugin["onCallEnd"];
  /** @deprecated Use `onCallError`. Kept as a working alias. */
  onNegotiationError?: ServerPlugin["onCallError"];
  /** @deprecated Use `onCallStart`. Kept as a working alias. */
  onJobStart?: ServerPlugin["onCallStart"];
  /** @deprecated Use `onCallEnd`. Kept as a working alias. */
  onJobEnd?: ServerPlugin["onCallEnd"];
  /** @deprecated Use `onCallError`. Kept as a working alias. */
  onJobError?: ServerPlugin["onCallError"];
}

export type ClientService = (data: any) => unknown | Promise<unknown>;
export type ClientServices = Record<string, ClientService>;
export type ServerAction = (data: any, request?: ServerRequest) => unknown | Promise<unknown>;
export type RouteHandler = (request: ServerRequest) => unknown | Promise<unknown>;

// ---------------------------------------------------------------------------
// Contract-first typed API (v1.6)
// ---------------------------------------------------------------------------

/** Phantom-typed client-service descriptor created with `svc()`. */
export interface ServiceSpec<TData = void, TResult = unknown> {
  readonly kind: "client-service";
  readonly __data?: TData;
  readonly __result?: TResult;
}

/** Phantom-typed server-action descriptor created with `act()`. */
export interface ActionSpec<TData = void, TResult = unknown> {
  readonly kind: "server-action";
  readonly __data?: TData;
  readonly __result?: TResult;
}

/** Declare a client service in a contract: `svc<Result, Data>()` (Data defaults to no-argument). */
export function svc<TResult = unknown, TData = void>(): ServiceSpec<TData, TResult> {
  return Object.freeze({ kind: "client-service" }) as unknown as ServiceSpec<TData, TResult>;
}

/** Declare a server action in a contract: `act<Result, Data>()` (Data defaults to no-argument). */
export function act<TResult = unknown, TData = void>(): ActionSpec<TData, TResult> {
  return Object.freeze({ kind: "server-action" }) as unknown as ActionSpec<TData, TResult>;
}

/** Long-form aliases for {@link svc} / {@link act}. */
export const defineService = svc;
export const defineAction = act;

export interface ContractDefinition {
  client?: Record<string, ServiceSpec<any, any>>;
  server?: Record<string, ActionSpec<any, any>>;
}

export interface EmptyContract {
  client: Record<never, never>;
  server: Record<never, never>;
}

/**
 * Define the shared contract once; both sides derive their types from it.
 *
 *   const contract = defineContract({
 *     client: { getName: svc<{ name: string }>() },
 *     server: { "math.add": act<number, { a: number; b: number }>() },
 *   });
 *   const server = createServer(contract);
 *   const client = createClient(contract);
 */
export function defineContract<C extends ContractDefinition>(contract: C): C {
  return contract;
}

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;

type SpecCall<S> = S extends { readonly __result?: infer R; readonly __data?: infer D }
  ? unknown extends D
    ? (data?: unknown) => Promise<R>
    : [D] extends [void]
      ? () => Promise<R>
      : (data: D) => Promise<R>
  : never;

type NestedProxy<K extends string, F> = K extends `${infer Head}.${infer Rest}`
  ? { [P in Head]: NestedProxy<Rest, F> }
  : { [P in K]: F };

type ClientMap<C> = C extends { client: infer M } ? M : Record<never, never>;
type ServerMap<C> = C extends { server: infer M } ? M : Record<never, never>;

/** Fully-typed `server.ask` proxy derived from a contract's client map. */
export type AskFor<C> = [keyof ClientMap<C>] extends [never]
  ? ClientServiceProxy
  : UnionToIntersection<
      { [K in keyof ClientMap<C> & string]: NestedProxy<K, SpecCall<ClientMap<C>[K]>> }[keyof ClientMap<C> & string]
    >;

/** Fully-typed `server.run` proxy derived from a contract's server map. */
export type RunFor<C> = [keyof ServerMap<C>] extends [never]
  ? ServerActionProxy
  : UnionToIntersection<
      { [K in keyof ServerMap<C> & string]: NestedProxy<K, SpecCall<ServerMap<C>[K]>> }[keyof ServerMap<C> & string]
    >;

/** Typed implementations for `client.provide(...)` (subset registration allowed). */
export type ClientServiceImplementations<C> = {
  [K in keyof ClientMap<C>]: ClientMap<C>[K] extends { readonly __result?: infer R; readonly __data?: infer D }
    ? (data: D) => R | Promise<R>
    : never;
};

export type ImplementFor<C> = [keyof ServerMap<C>] extends [never]
  ? Record<string, ServerAction>
  : Partial<ServerActionImplementations<C>>;

export type ProvideFor<C> = [keyof ClientMap<C>] extends [never]
  ? ClientServices
  : Partial<ClientServiceImplementations<C>>;

/** Typed implementations for `server.implement(...)` (subset registration allowed). */
export type ServerActionImplementations<C> = {
  [K in keyof ServerMap<C>]: ServerMap<C>[K] extends { readonly __result?: infer R; readonly __data?: infer D }
    ? (data: D, request?: ServerRequest) => R | Promise<R>
    : never;
};

/**
 * Magic client-service proxy (v1.3 syntax). Property access builds the
 * service name, calling it executes the service:
 *
 *   await server.ask.getName()            // -> server.require("getName")
 *   await server.ask.location.get()       // -> server.require("location.get")
 */
// Intentionally `any`: a dynamic proxy cannot be statically typed per
// service name, and `noUncheckedIndexedAccess` would otherwise force `!`
// on every access (defeating the short syntax). Annotate at the call site
// instead, e.g. `const name: string = await server.ask.getName();`.
export type ClientServiceProxy = any;

/**
 * Magic server-action proxy (v1.3 syntax). Nested properties build dotted
 * action names, and a bare leaf name resolves by suffix:
 *
 *   await server.run.math.add({ a: 2, b: 3 })         // -> "math.add"
 *   await server.run.getAvailableSlots({ ... })       // -> "delivery.getAvailableSlots"
 *   await server.run.mathAdd({ a: 2, b: 3 })          // -> "math.add" (normalised match)
 */
/** See {@link ClientServiceProxy}: intentionally dynamic (`any`). */
export type ServerActionProxy = any;

/**
 * Batch builder returned by `server.asks()` (v1.4 syntax). Chain service
 * calls without awaiting them, then execute them all in ONE negotiation
 * round (in parallel, like `requireMany`) with `done()`:
 *
 *   const asks = server.asks();
 *   asks.selectDeliverySlot({ orderId, slots }).getNames();
 *   const results = await asks.done();
 *   results[0];                   // first result, in call order
 *   results.selectDeliverySlot;   // same result, by service name
 *
 * Per-call options: `asks.getLocation(data, { fallback: null })`.
 * Intentionally dynamic (`any`), like the other proxy syntaxes.
 */
export type AsksBuilder = any;

/**
 * Batch builder returned by `server.runs()` (v1.5 syntax). The mirror of
 * `server.asks()` for server-side actions: chain calls without awaiting,
 * then execute them all (in parallel) with `done()`:
 *
 *   const runs = server.runs();
 *   runs.math.add({ a: 2, b: 3 }).delivery.getAvailableSlots({ period: "am" });
 *   const results = await runs.done();
 *   results[0];          // first result, in call order
 *   results.add;         // same result, by leaf action name
 *   results["math.add"]; // same result, by full dotted name
 *
 * Per-call options: `runs.math.add(data, { fallback: 0 })`.
 * Intentionally dynamic (`any`), like the other proxy syntaxes.
 */
export type RunsBuilder = any;

/** @internal Shared error normalisation (not part of the public API). */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** @internal Shared wire error shape (not part of the public API). */
export function errorPayload(value: unknown): { code: string; message: string } {
  const error = toError(value);
  const maybeCode = (value as { code?: unknown } | null)?.code;
  return {
    code: typeof maybeCode === "string" ? maybeCode : "INTERNAL_ERROR",
    message: error.message || "An unexpected error occurred",
  };
}

/** @internal Shared object check (not part of the public API). */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
