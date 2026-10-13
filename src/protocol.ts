import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";

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
  onRequest?: (
    request: HttpPluginRequest,
  ) => void | HttpPluginRequest | Promise<void | HttpPluginRequest>;
  onResponse?: (
    body: unknown,
    response: HttpPluginResponse,
  ) => void | unknown | Promise<void | unknown>;
  onError?: (error: Error, request: HttpPluginRequest) => void | Promise<void>;
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

type ImplementFor<C> = [keyof ServerMap<C>] extends [never]
  ? Record<string, ServerAction>
  : Partial<ServerActionImplementations<C>>;

type ProvideFor<C> = [keyof ClientMap<C>] extends [never]
  ? ClientServices
  : Partial<ClientServiceImplementations<C>>;

/** Typed implementations for `server.implement(...)` (subset registration allowed). */
export type ServerActionImplementations<C> = {
  [K in keyof ServerMap<C>]: ServerMap<C>[K] extends { readonly __result?: infer R; readonly __data?: infer D }
    ? (data: D, request?: ServerRequest) => R | Promise<R>
    : never;
};

export interface StoredRequestResponse {
  jobId: string;
  request: ServerRequest;
  response: NegotiationResponse;
  createdAt: string;
}

export interface RequestStore {
  save(entry: StoredRequestResponse): Promise<void>;
  close?(): Promise<void>;
}

export class MemoryRequestStore implements RequestStore {
  readonly records = new Map<string, StoredRequestResponse>();

  /** Bounded in-memory store: oldest entries are evicted beyond maxRecords. */
  constructor(private readonly maxRecords = 1_000) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
      throw new TypeError("MemoryRequestStore maxRecords must be a positive integer");
    }
  }

  async save(entry: StoredRequestResponse): Promise<void> {
    // Delete first so re-saving a job refreshes its eviction order.
    this.records.delete(entry.jobId);
    this.records.set(entry.jobId, structuredClone(entry));
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}

interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

/** Persists final request/response pairs to PostgreSQL. Requires the optional `pg` package. */
export class PostgresRequestStore implements RequestStore {
  private readonly poolPromise: Promise<PgPoolLike>;
  private initialized = false;
  private initPromise: Promise<void> | undefined;

  constructor(connectionString?: string) {
    // Use a variable import so PostgreSQL types are not required by consumers
    // that only use the default in-memory store.
    const packageName = "pg";
    this.poolPromise = import(packageName).then(({ Pool }) => new Pool(connectionString ? { connectionString } : {}) as PgPoolLike);
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    // Share one initialisation across concurrent save() calls.
    this.initPromise ??= (async () => {
      const pool = await this.poolPromise;
      await pool.query(`
        CREATE TABLE IF NOT EXISTS negotiation_logs (
          job_id TEXT PRIMARY KEY,
          request JSONB NOT NULL,
          response JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS negotiation_logs_created_at_idx ON negotiation_logs (created_at)`,
      );
      this.initialized = true;
    })();
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = undefined; // Allow a later save() to retry.
      throw error;
    }
  }

  async save(entry: StoredRequestResponse): Promise<void> {
    await this.init();
    const pool = await this.poolPromise;
    await pool.query(
      `INSERT INTO negotiation_logs (job_id, request, response, created_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::timestamptz)
       ON CONFLICT (job_id) DO UPDATE SET
         request = EXCLUDED.request,
         response = EXCLUDED.response,
         created_at = EXCLUDED.created_at`,
      [
        entry.jobId,
        JSON.stringify(entry.request),
        JSON.stringify(entry.response),
        entry.createdAt,
      ],
    );
  }

  async close(): Promise<void> {
    try {
      await (await this.poolPromise).end();
    } catch {
      // Pool never started (e.g. optional `pg` dependency missing): nothing to close.
    }
  }
}

export interface NegotiationServerOptions {
  publicBaseUrl?: string;
  callbackPath?: string;
  store?: RequestStore;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  /** Maximum simultaneously active jobs; new jobs get HTTP 503 beyond this. Default 1000. */
  maxJobs?: number;
  /** Overall lifetime of one logical job, across all rounds/callbacks. Default 600_000 (10 min). */
  jobTimeoutMs?: number;
  /** Structured error hook (replaces ad-hoc console logging). */
  onError?: (error: Error, info: { jobId?: string; path?: string; phase: string }) => void;
  /** Optional contract created with `defineContract()`; used for typed proxies. */
  contract?: ContractDefinition;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorPayload(value: unknown): { code: string; message: string } {
  const error = toError(value);
  const maybeCode = (value as { code?: unknown } | null)?.code;
  return {
    code: typeof maybeCode === "string" ? maybeCode : "INTERNAL_ERROR",
    message: error.message || "An unexpected error occurred",
  };
}

function headerRecord(headers: IncomingMessage["headers"]): ServerRequest["headers"] {
  return { ...headers };
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

/** Copy of a request safe to persist: credentials are never written to a RequestStore. */
function redactedRequestForStorage(request: ServerRequest): ServerRequest {
  const headers: ServerRequest["headers"] = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value;
  }
  return { ...request, headers };
}

/** Tokens are only ever stored as SHA-256 hashes and compared in constant time. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokensMatch(storedHash: string, providedToken: string): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(tokenHash(providedToken), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function responseHeaders(res: Response): Record<string, string> {
  const output: Record<string, string> = {};
  res.headers.forEach((value, key) => (output[key] = value));
  return output;
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<any> {
  // Framework mode (Express/Koa): a body parser may have already consumed
  // the stream and left the parsed value on `req.body`. Honour it, otherwise
  // reading the (ended) stream would silently yield an empty body.
  const preparsed = (req as IncomingMessage & { body?: unknown }).body;
  if (preparsed !== undefined) {
    if (typeof preparsed === "string" || Buffer.isBuffer(preparsed)) {
      const text = preparsed.toString();
      if (Buffer.byteLength(text) > maxBytes) {
        const error = new Error(`Request body exceeds ${maxBytes} bytes`);
        (error as Error & { code: string }).code = "BODY_TOO_LARGE";
        throw error;
      }
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        const error = new Error("Request body must be valid JSON");
        (error as Error & { code: string }).code = "INVALID_JSON";
        throw error;
      }
    }
    return preparsed;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      (error as Error & { code: string }).code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    (error as Error & { code: string }).code = "INVALID_JSON";
    throw error;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const encoded = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(encoded));
  res.end(encoded);
}

function waitForResponseEnd(res: ServerResponse): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off("finish", done);
      res.off("close", done);
      resolve();
    };
    res.once("finish", done);
    res.once("close", done);
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapActionResult(item: ActionResult): unknown {
  if (item.ok) return item.result;
  const error = new Error(item.error.message) as Error & { code: string };
  error.code = item.error.code;
  throw error;
}

interface PendingRound {
  round: number;
  expected: Set<string>;
  resolve(results: ActionResult[]): void;
  reject(error: unknown): void;
}

interface ExternalCallback {
  tokenHash: string;
  result: Deferred<unknown>;
  settled: boolean;
}

interface JobContext {
  jobId: string;
  /** SHA-256 hash only; the plain token exists solely in the response that issued it. */
  resumeTokenHash: string;
  expiryTimer?: ReturnType<typeof setTimeout>;
  request: ServerRequest;
  currentResponse: ServerResponse | null;
  round: number;
  result: unknown;
  resultSet: boolean;
  ended: boolean;
  pending: PendingRound | undefined;
  latestOutgoing?: NegotiationResponse;
  externalCallbacks: Map<string, ExternalCallback>;
  receivedExternalCallbacks: Set<string>;
  startedAt: string;
}

const ACTION_INVOCATION = Symbol("server-action-invocation");

/** A lazy server action: await it for direct execution, or pass it to createCallback. */
export class ServerActionInvocation<T = unknown> implements PromiseLike<T> {
  readonly [ACTION_INVOCATION] = true;

  constructor(
    readonly name: string,
    readonly data: unknown,
    private readonly run: (data: unknown) => Promise<T>,
  ) {}

  execute(dataOverride?: unknown): Promise<T> {
    return this.run(dataOverride === undefined ? this.data : dataOverride);
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

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

interface AskEntry {
  name: string;
  data?: unknown;
  fallback?: unknown;
  hasFallback: boolean;
}

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

interface RunEntry {
  name: string;
  data?: unknown;
  fallback?: unknown;
  hasFallback: boolean;
}

export class NegotiationServer<C extends ContractDefinition = EmptyContract> {
  private readonly storage = new AsyncLocalStorage<JobContext>();
  private readonly routes = new Map<string, RouteHandler>();
  private readonly actions = new Map<string, ServerAction>();
  private readonly jobs = new Map<string, JobContext>();
  private readonly callbackPaths = new Set<string>();
  private readonly store: RequestStore;
  private httpServerInstance: HttpServer | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private readonly publicBaseUrl: string | undefined;
  private readonly defaultCallbackPath: string;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly maxJobs: number;
  private readonly jobTimeoutMs: number;
  private readonly onError: NegotiationServerOptions["onError"];
  readonly contract: C | undefined;

  constructor(options: (NegotiationServerOptions & { contract?: C }) = {}) {
    this.contract = options.contract;
    this.store = options.store ?? new MemoryRequestStore();
    this.publicBaseUrl = options.publicBaseUrl;
    this.defaultCallbackPath = options.callbackPath ?? "/__negotiation/callback";
    this.callbackPaths.add(new URL(this.defaultCallbackPath, "http://localhost").pathname);
    this.maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.maxJobs = options.maxJobs ?? 1_000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 600_000;
    this.onError = options.onError;
  }

  private reportError(error: unknown, info: { jobId?: string; path?: string; phase: string }): void {
    try {
      this.onError?.(toError(error), info);
    } catch {
      // An error hook must never break request handling.
    }
  }

  private expireJob(context: JobContext): void {
    if (context.ended) return;
    const error = Object.assign(
      new Error(`Negotiation job ${context.jobId} exceeded its maximum lifetime`),
      { code: "JOB_EXPIRED" },
    );
    if (context.pending) {
      const pending = context.pending;
      context.pending = undefined;
      pending.reject(error);
    }
    for (const callback of context.externalCallbacks.values()) {
      if (!callback.settled) {
        callback.settled = true;
        callback.result.reject(error);
      }
    }
    this.jobs.delete(context.jobId);
  }

  /** Register an HTTP route that participates in negotiation. */
  handle(path: string, handler: RouteHandler): this {
    this.routes.set(new URL(path, "http://localhost").pathname, handler);
    return this;
  }

  /** Register server-side actions that can be invoked with Server.call(). */
  use(actions: Record<string, ServerAction>): this {
    for (const [name, action] of Object.entries(actions)) {
      if (!name.trim() || typeof action !== "function") {
        throw new TypeError("Server.use expects a map of action names to functions");
      }
      this.actions.set(name, action);
    }
    return this;
  }

  /**
   * Magic proxy for client services: `await server.ask.getName(data)`.
   * With a contract (see `createServer`) this is fully typed/autocompleted.
   */
  get ask(): AskFor<C> {
    return this.createPathProxy([], async (path, data) => {
      if (!path) throw new TypeError("server.ask must be called on a service name, e.g. server.ask.getName()");
      if (this.contract?.client && !(path in this.contract.client)) {
        throw new TypeError(`Client service '${path}' is not defined in the contract`);
      }
      return this.require(path, data);
    }) as AskFor<C>;
  }

  /**
   * Magic proxy for server actions: `await server.run.math.add(data)`.
   * With a contract (see `createServer`) this is fully typed/autocompleted.
   */
  get run(): RunFor<C> {
    return this.createPathProxy([], async (path, data) => {
      if (!path) throw new TypeError("server.run must be called on an action name, e.g. server.run.math.add()");
      return await this.call(this.resolveServerActionName(path), data);
    }) as RunFor<C>;
  }

  /**
   * Register server actions with contract-checked argument/return types.
   * Subsets are allowed; call it more than once to register the rest.
   */
  implement(actions: ImplementFor<C>): this {
    if (this.contract?.server) {
      for (const name of Object.keys(actions)) {
        if (!(name in this.contract.server)) {
          throw new TypeError(`Server action '${name}' is not defined in the contract`);
        }
      }
    }
    return this.use(actions as Record<string, ServerAction>);
  }

  private resolveServerActionName(path: string): string {
    if (this.actions.has(path)) return path;
    const suffix = [...this.actions.keys()].filter((key) => key.endsWith(`.${path}`));
    if (suffix.length === 1) return suffix[0] as string;
    if (suffix.length > 1) {
      throw new Error(`Ambiguous server action '${path}' (matches: ${suffix.join(", ")}); use the full dotted name`);
    }
    const normalize = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    const wanted = normalize(path);
    const fuzzy = [...this.actions.keys()].filter((key) => {
      const candidate = normalize(key);
      return candidate === wanted || candidate.endsWith(wanted);
    });
    if (fuzzy.length === 1) return fuzzy[0] as string;
    if (fuzzy.length > 1) {
      throw new Error(`Ambiguous server action '${path}' (matches: ${fuzzy.join(", ")}); use the full dotted name`);
    }
    return path; // Let call() produce the standard "Unknown server action" error.
  }

  private createPathProxy(
    segments: string[],
    invoke: (path: string, data?: unknown) => Promise<unknown>,
  ): unknown {
    const callable = (data?: unknown) => invoke(segments.join("."), data);
    return new Proxy(callable, {
      get: (target, prop) => {
        if (typeof prop !== "string") return Reflect.get(target, prop);
        // Never become a thenable / never shadow real Function members.
        if (prop === "then" || prop === "catch" || prop === "finally" || prop in target) {
          return Reflect.get(target, prop);
        }
        return this.createPathProxy([...segments, prop], invoke);
      },
      apply: (_target, _thisArg, args) => invoke(segments.join("."), args[0] as unknown),
    });
  }

  /**
   * Framework integration (Express, Koa, Fastify-raw, plain `node:http`):
   * a standard Node request handler implementing the whole protocol
   * (routes, `/__negotiation/resume`, external callbacks).
   *
   *   const app = express();
   *   app.use(express.json());            // optional; pre-parsed bodies are honoured
   *   app.use(server.requestHandler());   // mount at the root
   *
   * In this mode you own the HTTP server. Either call `server.attach(http)`
   * to wire close/error events and let `server.close()` close it too, or
   * close it yourself and call `server.close()` for jobs/store cleanup only
   * (an unattached `close()` never touches your HTTP server).
   * Mount at the root: route matching uses the full request path.
   */
  requestHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.handleRequest(req, res);
    };
  }

  /** Handle a single framework request; resolves when the turn is answered. */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.dispatch(req, res);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errorPayload(error) });
    }
  }

  /**
   * The underlying HTTP server when this instance owns one (`listen()`)
   * or is attached to an external one (`attach()`); otherwise `undefined`.
   */
  get httpServer(): HttpServer | undefined {
    return this.httpServerInstance;
  }

  /**
   * Attach to an HTTP server you own, typically created around a framework
   * app (Express/Koa/Fastify). This initialises the lifecycle wiring that
   * framework mode otherwise lacks:
   *
   * - `httpServer` becomes inspectable (instead of always `undefined`);
   * - server "error" events are forwarded to the `onError` option;
   * - when the HTTP server emits "close" (for any reason), pending jobs are
   *   rejected and the store is closed — exactly once;
   * - `server.close()` also closes the attached HTTP server.
   *
   *   const http = createHttpServer(app);
   *   server.attach(http);
   *   http.listen(3000);
   *   // on shutdown: await server.close();  // closes http too
   *
   * Without `attach()`, `close()` only cleans up jobs/store and never
   * touches your HTTP server.
   */
  attach(httpServer: HttpServer): this {
    if (this.httpServerInstance && this.httpServerInstance !== httpServer) {
      throw new Error("NegotiationServer is already attached to an HTTP server");
    }
    if (this.httpServerInstance === httpServer) return this;
    this.httpServerInstance = httpServer;
    const onError = (error: Error) => this.reportError(error, { phase: "http-server" });
    const onClose = () => {
      httpServer.off("error", onError);
      if (this.httpServerInstance === httpServer) this.httpServerInstance = undefined;
      // External shutdown path: clean up jobs/store even if close() is never called.
      void this.shutdownNegotiation();
    };
    httpServer.on("error", onError);
    httpServer.once("close", onClose);
    return this;
  }

  async listen(port = 3000, host = "127.0.0.1"): Promise<void> {
    if (this.httpServerInstance) throw new Error("Server is already listening");
    const httpServer = createHttpServer(this.requestHandler());
    this.attach(httpServer);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
  }

  /** Idempotent negotiation cleanup: reject pending work and close the store, once. */
  private shutdownNegotiation(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      // Fail every suspended job first so handlers unwind instead of hanging.
      const shutdownError = Object.assign(new Error("Negotiation server is shutting down"), {
        code: "SERVER_SHUTDOWN",
      });
      for (const context of this.jobs.values()) {
        if (context.expiryTimer) clearTimeout(context.expiryTimer);
        context.ended = true;
        if (context.pending) {
          const pending = context.pending;
          context.pending = undefined;
          pending.reject(shutdownError);
        }
        for (const callback of context.externalCallbacks.values()) {
          if (!callback.settled) {
            callback.settled = true;
            callback.result.reject(shutdownError);
          }
        }
      }
      this.jobs.clear();
      await this.store.close?.();
    })();
    return this.shutdownPromise;
  }

  async close(): Promise<void> {
    const httpServer = this.httpServerInstance;
    this.httpServerInstance = undefined;
    await this.shutdownNegotiation();
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        // Do not let idle keep-alive sockets stall shutdown.
        httpServer.closeAllConnections?.();
      });
    }
  }

  /** Stores the result; the actual HTTP response is sent by end(). */
  respond(request: ServerRequest, result: unknown): void {
    const context = this.requireContext(request);
    context.result = result;
    context.resultSet = true;
  }

  /**
   * Ask the client to execute one registered service and return its value.
   * Service errors become ordinary thrown Errors, so callers can use try/catch.
   */
  async require<T = unknown>(name: string, data?: unknown): Promise<T>;
  /** Ask the client to execute several registered services in one HTTP round. */
  async require<T = unknown>(actions: ClientServiceRequest[]): Promise<T[]>;
  /** Low-level compatibility overload for callers that need per-action status objects. */
  async require(input: { actions: ClientAction[] }): Promise<ActionResult[]>;
  async require<T = unknown>(
    input: string | ClientServiceRequest[] | { actions: ClientAction[] },
    data?: unknown,
  ): Promise<T | T[] | ActionResult[]> {
    if (typeof input === "string") {
      const [result] = await this.requestClientActions([
        { name: input, data, callbackID: `cb_${randomUUID()}` },
      ]);
      if (!result) throw new Error(`Missing result for client action '${input}'`);
      return unwrapActionResult(result) as T;
    }
    if (Array.isArray(input)) {
      if (input.length === 0) return [] as T[];
      const actions = input.map((action) => ({
        name: action.name,
        data: action.data ?? null,
        callbackID: `cb_${randomUUID()}`,
      }));
      const results = await this.requestClientActions(actions);
      return results.map((result, index) => {
        if (!result) throw new Error(`Missing result for client action at index ${index}`);
        if (result.ok) return result.result;
        const descriptor = input[index];
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "fallback")) {
          return descriptor.fallback;
        }
        return unwrapActionResult(result);
      }) as T[];
    }
    return this.requestClientActions(input.actions);
  }

  /** Explicitly named alternative when a batch of client services is required. */
  async requireMany<T = unknown>(actions: ClientServiceRequest[]): Promise<T[]> {
    return await this.require<T>(actions);
  }

  /**
   * Batch builder for parallel client services: chain calls now, run them
   * all in a single negotiation round with `await asks.done()`.
   * The builder is single-use; create a new one for the next round.
   */
  asks(): AsksBuilder {
    const entries: AskEntry[] = [];
    let executed = false;

    const done = async (): Promise<any> => {
      if (executed) {
        throw new Error("asks.done() can only be called once; create a new builder with server.asks()");
      }
      executed = true;
      if (entries.length === 0) return [];
      const descriptors: ClientServiceRequest[] = entries.map((entry) => {
        const descriptor: ClientServiceRequest = { name: entry.name, data: entry.data };
        if (entry.hasFallback) descriptor.fallback = entry.fallback;
        return descriptor;
      });
      const values = await this.requireMany<unknown>(descriptors);
      // Array in call order, with each result also attached by service name
      // (leaf name and full dotted name) for named access.
      const results: any = [...values];
      entries.forEach((entry, index) => {
        results[entry.name] = values[index];
        const leaf = entry.name.split(".").pop();
        if (leaf && leaf !== entry.name) results[leaf] = values[index];
      });
      return results;
    };

    const enqueue = (path: string, data?: unknown, options?: { fallback?: unknown }): AsksBuilder => {
      if (executed) {
        throw new Error("Cannot add asks after done(); create a new builder with server.asks()");
      }
      if (!path) throw new TypeError("asks must be called on a service name, e.g. asks.getName()");
      entries.push({
        name: path,
        data,
        hasFallback: options != null && Object.prototype.hasOwnProperty.call(options, "fallback"),
        ...(options != null && Object.prototype.hasOwnProperty.call(options, "fallback")
          ? { fallback: options.fallback }
          : {}),
      });
      return root;
    };

    const createNode = (segments: string[]): AsksBuilder => {
      const callable = (data?: unknown, options?: { fallback?: unknown }) =>
        enqueue(segments.join("."), data, options);
      return new Proxy(callable, {
        get: (target, prop) => {
          if (segments.length === 0 && prop === "done") return () => done();
          if (segments.length === 0 && prop === "then") {
            // The builder itself is awaitable: `await asks` === `await asks.done()`.
            return (resolve: unknown, reject: unknown) =>
              done().then(resolve as never, reject as never);
          }
          if (typeof prop !== "string") return Reflect.get(target, prop);
          if (prop in target) return Reflect.get(target, prop);
          return createNode([...segments, prop]);
        },
        apply: (_target, _thisArg, args) =>
          enqueue(segments.join("."), args[0] as unknown, args[1] as { fallback?: unknown } | undefined),
      });
    };

    const root: AsksBuilder = createNode([]);
    return root;
  }

  /**
   * Batch builder for server-side actions: chain calls now, execute them
   * all in parallel with `await runs.done()`. Unlike `asks()`, this costs
   * no network round — actions are local — but it is handy when several
   * independent actions should be declared together and read as one result.
   * The builder is single-use; create a new one for the next batch.
   */
  runs(): RunsBuilder {
    const entries: RunEntry[] = [];
    let executed = false;

    const done = async (): Promise<any> => {
      if (executed) {
        throw new Error("runs.done() can only be called once; create a new builder with server.runs()");
      }
      executed = true;
      if (entries.length === 0) return [];
      const values = await Promise.all(entries.map(async (entry) => {
        try {
          return await this.call(this.resolveServerActionName(entry.name), entry.data);
        } catch (error) {
          if (entry.hasFallback) return entry.fallback;
          throw error;
        }
      }));
      // Array in call order, with each result also attached by action name
      // (leaf name and full dotted name) for named access.
      const results: any = [...values];
      entries.forEach((entry, index) => {
        results[entry.name] = values[index];
        const resolved = this.resolveServerActionName(entry.name);
        if (resolved !== entry.name) results[resolved] = values[index];
        const leaf = resolved.split(".").pop();
        if (leaf && leaf !== resolved) results[leaf] = values[index];
      });
      return results;
    };

    const enqueue = (path: string, data?: unknown, options?: { fallback?: unknown }): RunsBuilder => {
      if (executed) {
        throw new Error("Cannot add runs after done(); create a new builder with server.runs()");
      }
      if (!path) throw new TypeError("runs must be called on an action name, e.g. runs.math.add()");
      entries.push({
        name: path,
        data,
        hasFallback: options != null && Object.prototype.hasOwnProperty.call(options, "fallback"),
        ...(options != null && Object.prototype.hasOwnProperty.call(options, "fallback")
          ? { fallback: options.fallback }
          : {}),
      });
      return root;
    };

    const createNode = (segments: string[]): RunsBuilder => {
      const callable = (data?: unknown, options?: { fallback?: unknown }) =>
        enqueue(segments.join("."), data, options);
      return new Proxy(callable, {
        get: (target, prop) => {
          if (segments.length === 0 && prop === "done") return () => done();
          if (segments.length === 0 && prop === "then") {
            // The builder itself is awaitable: `await runs` === `await runs.done()`.
            return (resolve: unknown, reject: unknown) =>
              done().then(resolve as never, reject as never);
          }
          if (typeof prop !== "string") return Reflect.get(target, prop);
          if (prop in target) return Reflect.get(target, prop);
          return createNode([...segments, prop]);
        },
        apply: (_target, _thisArg, args) =>
          enqueue(segments.join("."), args[0] as unknown, args[1] as { fallback?: unknown } | undefined),
      });
    };

    const root: RunsBuilder = createNode([]);
    return root;
  }

  private async requestClientActions(inputActions: ClientAction[]): Promise<ActionResult[]> {
    const context = this.requireContext();
    if (context.ended) throw new Error("Cannot negotiate after Server.end()");
    if (context.pending) throw new Error("This job already has a pending negotiation round");
    if (!Array.isArray(inputActions) || inputActions.length === 0) {
      throw new TypeError("Server.require expects at least one action");
    }

    const ids = inputActions.map((action) => action.callbackID);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new Error("Every action must have a unique, non-empty callbackID");
    }

    const round = context.round + 1;
    context.round = round;
    const wait = deferred<ActionResult[]>();
    context.pending = {
      round,
      expected: new Set(ids),
      resolve: wait.resolve,
      reject: wait.reject,
    };

    // Rotate the resume token every round: a leaked token can only ever
    // resume the single round it was issued for, and only once.
    const resumeToken = randomUUID();
    context.resumeTokenHash = tokenHash(resumeToken);
    const response: NegotiationResponse = {
      protocol: 1,
      jobId: context.jobId,
      round,
      done: false,
      result: null,
      actions: inputActions,
      resumeUrl: "/__negotiation/resume",
      resumeToken,
    };
    this.sendProtocolResponse(context, response);

    const timeout = setTimeout(() => {
      if (context.pending?.round === round) {
        context.pending = undefined;
        wait.reject(new Error(`Negotiation round ${round} timed out`));
      }
    }, this.requestTimeoutMs);
    try {
      return await wait.promise;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Execute a registered server-side action. Await the result directly.
   * For external webhooks, use callback() to hide callback IDs and tokens.
   */
  call<T = unknown>(name: string, data: unknown): ServerActionInvocation<T> {
    return new ServerActionInvocation<T>(name, data, async (input) => {
      const action = this.actions.get(name);
      if (!action) throw new Error(`Unknown server action: ${name}`);
      const context = this.storage.getStore();
      return (await action(input, context?.request)) as T;
    });
  }

  /**
   * Run a server action that arranges an external callback, then wait for that callback.
   * The action receives an automatically generated callbackUrl. The caller never
   * needs to create or track jobId/callbackID/token values.
   */
  async callback<T = unknown>(
    actionName: string,
    data: unknown,
    callbackPathOrUrl?: string,
  ): Promise<T> {
    const context = this.requireContext();
    return this.createCallback<T>(context.request, this.call(actionName, data), callbackPathOrUrl);
  }

  /**
   * Starts a server-side action and waits for an external callback to arrive.
   * callbackOrUrl can be a callback function or a callback endpoint URL/path.
   * The action receives { ...data, jobId, callbackID, callbackUrl }.
   */
  createCallback<T = unknown>(
    request: ServerRequest,
    actionCall: ServerActionInvocation<unknown>,
    callbackOrUrl?: ((payload: T) => unknown | Promise<unknown>) | string,
  ): Promise<T> {
    const context = this.requireContext(request);
    if (!(actionCall instanceof ServerActionInvocation) || !actionCall[ACTION_INVOCATION]) {
      throw new TypeError("Server.createCallback expects Server.call(action, data) as its second argument");
    }

    const callbackID = `cb_${randomUUID()}`;
    const token = randomUUID();
    const callbackBase = typeof callbackOrUrl === "string" ? callbackOrUrl : this.defaultCallbackPath;
    const base = this.publicBaseUrl ?? context.request.origin;
    const callbackURL = new URL(callbackBase, base);
    this.callbackPaths.add(callbackURL.pathname);
    callbackURL.searchParams.set("jobId", context.jobId);
    callbackURL.searchParams.set("callbackID", callbackID);
    callbackURL.searchParams.set("token", token);

    const wait = deferred<T>();
    context.externalCallbacks.set(callbackID, {
      tokenHash: tokenHash(token),
      result: wait as Deferred<unknown>,
      settled: false,
    });

    const originalData = actionCall.data;
    const injectedData: Record<string, unknown> = isObjectRecord(originalData)
      ? { ...originalData, jobId: context.jobId, callbackID, callbackUrl: callbackURL.toString() }
      : { value: originalData, jobId: context.jobId, callbackID, callbackUrl: callbackURL.toString() };

    // Register the callback before starting the action so an immediate webhook cannot race registration.
    void actionCall.execute(injectedData).catch((error: unknown) => {
      const entry = context.externalCallbacks.get(callbackID);
      if (entry && !entry.settled) {
        entry.settled = true;
        entry.result.reject(error);
      }
    });

    const callbackTimer = setTimeout(() => {
      const entry = context.externalCallbacks.get(callbackID);
      if (entry && !entry.settled) {
        entry.settled = true;
        entry.result.reject(new Error(`External callback ${callbackID} timed out`));
      }
    }, this.requestTimeoutMs);

    return wait.promise.then(async (payload) => {
      if (typeof callbackOrUrl === "function") await callbackOrUrl(payload);
      return payload;
    }).finally(() => clearTimeout(callbackTimer));
  }

  /** Finish this job, optionally set the final result, persist it, and answer the current HTTP turn. */
  async end(result?: unknown): Promise<void> {
    const context = this.requireContext();
    if (context.ended) return;
    if (context.expiryTimer) clearTimeout(context.expiryTimer);
    if (arguments.length > 0) {
      context.result = result;
      context.resultSet = true;
    }

    const response: NegotiationResponse = {
      protocol: 1,
      jobId: context.jobId,
      round: context.round,
      done: true,
      result: context.resultSet ? context.result : null,
      actions: [],
    };
    await this.store.save({
      jobId: context.jobId,
      request: redactedRequestForStorage(context.request),
      response,
      createdAt: context.startedAt,
    });
    context.ended = true;
    context.latestOutgoing = response;
    this.sendJsonToCurrentResponse(context, response);
    this.cleanupWhenFinished(context);
  }

  /** Allows read-only diagnostics/testing without exposing the mutable jobs map. */
  getJobCount(): number {
    return this.jobs.size;
  }

  private requireContext(request?: ServerRequest): JobContext {
    const context = this.storage.getStore();
    if (!context) throw new Error("This Server method must run inside a Server.handle() job");
    if (request && request !== context.request) {
      throw new Error("The supplied request does not belong to the current job");
    }
    return context;
  }

  private sendProtocolResponse(context: JobContext, response: NegotiationResponse): void {
    context.latestOutgoing = response;
    this.sendJsonToCurrentResponse(context, response);
  }

  private sendJsonToCurrentResponse(context: JobContext, payload: unknown): void {
    const response = context.currentResponse;
    if (!response || response.writableEnded || response.destroyed) {
      throw new Error("There is no open HTTP response for this negotiation turn");
    }
    sendJson(response, 200, payload);
  }

  private cleanupWhenFinished(context: JobContext): void {
    if (context.expiryTimer) clearTimeout(context.expiryTimer);
    const response = context.currentResponse;
    if (!response) {
      this.jobs.delete(context.jobId);
      return;
    }
    const cleanup = () => {
      response.off("finish", cleanup);
      response.off("close", cleanup);
      this.jobs.delete(context.jobId);
    };
    if (response.writableEnded || response.destroyed) {
      this.jobs.delete(context.jobId);
    } else {
      response.once("finish", cleanup);
      response.once("close", cleanup);
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "127.0.0.1";
    const forwardedProto = req.headers["x-forwarded-proto"];
    const origin = this.publicBaseUrl ?? `${Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto ?? "http"}://${host}`;
    const expressUrl = (req as IncomingMessage & { originalUrl?: string }).originalUrl;
    const url = new URL(expressUrl ?? req.url ?? "/", origin);

    if (req.method === "POST" && url.pathname === "/__negotiation/resume") {
      await this.handleResume(req, res);
      return;
    }
    if (req.method === "POST" && this.callbackPaths.has(url.pathname)) {
      await this.handleExternalCallback(req, res, url);
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } });
      return;
    }
    const route = this.routes.get(url.pathname);
    if (!route) {
      sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `No route: ${url.pathname}` } });
      return;
    }
    if (this.jobs.size >= this.maxJobs) {
      sendJson(res, 503, { ok: false, error: { code: "TOO_MANY_JOBS", message: "Too many active negotiation jobs" } });
      return;
    }

    let body: any;
    try {
      body = await readJson(req, this.maxBodyBytes);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorPayload(error) });
      return;
    }
    if (!isObjectRecord(body)) {
      sendJson(res, 400, { ok: false, error: { code: "INVALID_BODY", message: "Request body must be a JSON object" } });
      return;
    }

    const jobId = randomUUID();
    const context: JobContext = {
      jobId,
      resumeTokenHash: tokenHash(randomUUID()),
      request: {
        jobId,
        method: req.method,
        path: url.pathname,
        origin,
        params: isObjectRecord(body.params) ? body.params : {},
        data: body.data,
        headers: headerRecord(req.headers),
      },
      currentResponse: res,
      round: 0,
      result: null,
      resultSet: false,
      ended: false,
      pending: undefined,
      externalCallbacks: new Map(),
      receivedExternalCallbacks: new Set(),
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, context);
    context.expiryTimer = setTimeout(() => this.expireJob(context), this.jobTimeoutMs);
    context.expiryTimer.unref?.();

    // The handler remains suspended at Server.require() while separate HTTP requests resume it.
    await this.storage.run(context, async () => {
      try {
        const returned = await route(context.request);
        if (!context.ended) {
          if (!context.resultSet && returned !== undefined) {
            context.result = returned;
            context.resultSet = true;
          }
          await this.end();
        }
      } catch (error) {
        await this.finishWithError(context, error);
      }
    });
  }

  private async handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: any;
    try {
      body = await readJson(req, this.maxBodyBytes);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorPayload(error) });
      return;
    }
    if (!isObjectRecord(body)) {
      sendJson(res, 400, { ok: false, error: { code: "INVALID_BODY", message: "Request body must be a JSON object" } });
      return;
    }

    const context = this.jobs.get(String(body.jobId ?? ""));
    if (!context || context.ended) {
      sendJson(res, 404, { ok: false, error: { code: "UNKNOWN_JOB", message: "Job not found or already finished" } });
      return;
    }
    if (typeof body.resumeToken !== "string" || !tokensMatch(context.resumeTokenHash, body.resumeToken)) {
      sendJson(res, 403, { ok: false, error: { code: "INVALID_RESUME_TOKEN", message: "Invalid resume token" } });
      return;
    }

    const pending = context.pending;
    if (!pending || body.round !== pending.round) {
      sendJson(res, 409, { ok: false, error: { code: "UNEXPECTED_ROUND", message: "No matching negotiation round is pending" } });
      return;
    }

    if (!Array.isArray(body.results)) {
      sendJson(res, 400, { ok: false, error: { code: "INVALID_RESULTS", message: "results must be an array" } });
      return;
    }
    const resultIds = body.results.map((item: any) => item?.callbackID);
    if (
      resultIds.some((id: unknown) => typeof id !== "string") ||
      new Set(resultIds).size !== resultIds.length ||
      resultIds.length !== pending.expected.size ||
      resultIds.some((id: string) => !pending.expected.has(id))
    ) {
      sendJson(res, 400, { ok: false, error: { code: "INVALID_CALLBACK_IDS", message: "Results must contain every expected callbackID exactly once" } });
      return;
    }

    const normalized: ActionResult[] = [];
    for (const item of body.results) {
      if (item.ok === true) {
        normalized.push({ callbackID: item.callbackID, ok: true, result: item.result });
      } else if (item.ok === false && isObjectRecord(item.error)) {
        normalized.push({
          callbackID: item.callbackID,
          ok: false,
          error: {
            code: typeof item.error.code === "string" ? item.error.code : "ACTION_FAILED",
            message: typeof item.error.message === "string" ? item.error.message : "Action failed",
          },
        });
      } else {
        sendJson(res, 400, { ok: false, error: { code: "INVALID_ACTION_RESULT", message: "Each result must include ok: true or ok: false" } });
        return;
      }
    }

    const responseFinished = waitForResponseEnd(res);
    context.currentResponse = res;
    context.pending = undefined;
    pending.resolve(normalized);
    await responseFinished;
  }

  private async handleExternalCallback(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } });
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req, this.maxBodyBytes);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorPayload(error) });
      return;
    }

    const jobId = url.searchParams.get("jobId") ?? "";
    const callbackID = url.searchParams.get("callbackID") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const context = this.jobs.get(jobId);
    const callback = context?.externalCallbacks.get(callbackID);
    if (!context || !callback || !tokensMatch(callback.tokenHash, token)) {
      sendJson(res, 403, { ok: false, error: { code: "INVALID_CALLBACK", message: "Unknown callback or invalid token" } });
      return;
    }
    if (callback.settled || context.receivedExternalCallbacks.has(callbackID)) {
      sendJson(res, 200, { ok: true, duplicate: true });
      return;
    }

    callback.settled = true;
    context.receivedExternalCallbacks.add(callbackID);
    callback.result.resolve(body);
    sendJson(res, 200, { ok: true, received: true });
  }

  private async finishWithError(context: JobContext, error: unknown): Promise<void> {
    if (context.ended) return;
    const response: NegotiationResponse = {
      protocol: 1,
      jobId: context.jobId,
      round: context.round,
      done: true,
      error: errorPayload(error),
      actions: [],
    };
    if (context.expiryTimer) clearTimeout(context.expiryTimer);
    try {
      await this.store.save({
        jobId: context.jobId,
        request: redactedRequestForStorage(context.request),
        response,
        createdAt: context.startedAt,
      });
    } catch (storeError) {
      this.reportError(storeError, { jobId: context.jobId, path: context.request.path, phase: "store" });
    }
    context.ended = true;
    context.latestOutgoing = response;
    const currentResponse = context.currentResponse;
    if (currentResponse && !currentResponse.writableEnded && !currentResponse.destroyed) {
      sendJson(currentResponse, 200, response);
      this.cleanupWhenFinished(context);
    } else {
      this.jobs.delete(context.jobId);
    }
  }
}

/** Create a contract-typed server: `const server = createServer(contract, options?)`. */
export function createServer<C extends ContractDefinition>(
  contract: C,
  options: NegotiationServerOptions = {},
): NegotiationServer<C> {
  return new NegotiationServer<C>({ ...options, contract });
}

export interface NegotiationClientOptions {
  serviceTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Optional contract created with `defineContract()`; used for typed `provide()`. */
  contract?: ContractDefinition;
  /** Maximum negotiation rounds per logical call; guards against server loops. Default 100. */
  maxRounds?: number;
  /** Maximum accepted response body size in bytes. Default 1_000_000. */
  maxResponseBytes?: number;
}

export class NegotiationClient<C extends ContractDefinition = EmptyContract> {
  private readonly plugins: ClientPlugin[] = [];
  private readonly services = new Map<string, ClientService>();
  private readonly serviceTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRounds: number;
  private readonly maxResponseBytes: number;

  readonly contract: C | undefined;

  constructor(options: (NegotiationClientOptions & { contract?: C }) = {}) {
    this.contract = options.contract;
    this.serviceTimeoutMs = options.serviceTimeoutMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.maxRounds = options.maxRounds ?? 100;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  }

  /** Register one/many HTTP plugins, or a map of named client-side services. */
  use(pluginOrServices: ClientPlugin | ClientPlugin[] | ClientServices): this {
    if (Array.isArray(pluginOrServices)) {
      for (const plugin of pluginOrServices) {
        if (!isObjectRecord(plugin)) throw new TypeError("Each client plugin must be an object");
        this.plugins.push(plugin as ClientPlugin);
      }
    } else if (isObjectRecord(pluginOrServices) &&
      ("onRequest" in pluginOrServices || "onResponse" in pluginOrServices || "onError" in pluginOrServices)) {
      this.plugins.push(pluginOrServices as ClientPlugin);
    } else {
      for (const [name, service] of Object.entries(pluginOrServices)) {
        if (typeof service !== "function") throw new TypeError(`Client service '${name}' must be a function`);
        this.services.set(name, service as ClientService);
      }
    }
    return this;
  }

  /**
   * Register client services with contract-checked argument/return types.
   * Subsets are allowed; call it more than once to register the rest.
   */
  provide(services: ProvideFor<C>): this {
    if (this.contract?.client) {
      for (const name of Object.keys(services)) {
        if (!(name in this.contract.client)) {
          throw new TypeError(`Client service '${name}' is not defined in the contract`);
        }
      }
    }
    return this.use(services as ClientServices);
  }

  async call(request: ClientCallRequest): Promise<unknown> {
    if (!request.url) throw new TypeError("Client.call requires url");
    const maxRounds = request.maxRounds ?? this.maxRounds;
    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new TypeError("maxRounds must be a positive integer");
    }
    const initialUrl = new URL(request.url);
    const initialBody = { params: request.params ?? {}, data: request.data ?? null };
    let response = await this.send(initialUrl.toString(), initialBody, request.headers ?? {}, "initial", request.signal);

    let rounds = 0;
    let lastRound = 0;
    while (true) {
      if (request.signal?.aborted) {
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : Object.assign(new Error("Client.call was aborted"), { code: "ABORTED" });
      }
      const protocol = response.body;
      if (!isObjectRecord(protocol) || protocol.protocol !== 1 || typeof protocol.done !== "boolean") {
        throw new Error("Server returned an invalid negotiation response");
      }
      if (typeof protocol.round !== "number" || !Number.isInteger(protocol.round) || protocol.round < 0) {
        throw new Error("Negotiation response round must be a non-negative integer");
      }
      if (!protocol.done && protocol.round <= lastRound) {
        throw new Error(`Negotiation round did not advance (received round ${protocol.round} after ${lastRound})`);
      }
      lastRound = protocol.round;
      if (protocol.done) {
        if (isObjectRecord(protocol.error)) {
          const error = new Error(String(protocol.error.message ?? "Server request failed"));
          (error as Error & { code: string }).code = String(protocol.error.code ?? "SERVER_ERROR");
          throw error;
        }
        return protocol.result;
      }

      if (typeof protocol.jobId !== "string" || typeof protocol.resumeUrl !== "string" || typeof protocol.resumeToken !== "string") {
        throw new Error("Negotiation response is missing jobId, resumeUrl, or resumeToken");
      }
      if (!Array.isArray(protocol.actions)) throw new Error("Negotiation response actions must be an array");

      rounds += 1;
      if (rounds > maxRounds) {
        throw Object.assign(new Error(`Negotiation exceeded the maximum of ${maxRounds} rounds`), {
          code: "MAX_ROUNDS_EXCEEDED",
        });
      }

      const results = await Promise.all(protocol.actions.map((action) => this.executeAction(action as ClientAction, request.signal)));
      const resumeUrl = new URL(protocol.resumeUrl, initialUrl).toString();
      response = await this.send(
        resumeUrl,
        {
          jobId: protocol.jobId,
          round: protocol.round,
          resumeToken: protocol.resumeToken,
          results,
        },
        request.headers ?? {},
        "resume",
        request.signal,
      );
    }
  }

  private async executeAction(action: ClientAction, signal?: AbortSignal): Promise<ActionResult> {
    if (!action || typeof action.name !== "string" || typeof action.callbackID !== "string") {
      return {
        callbackID: String((action as any)?.callbackID ?? "invalid"),
        ok: false,
        error: { code: "INVALID_ACTION", message: "Malformed action received from server" },
      };
    }
    const service = this.services.get(action.name);
    if (!service) {
      return {
        callbackID: action.callbackID,
        ok: false,
        error: { code: "SERVICE_NOT_FOUND", message: `No client service registered for '${action.name}'` },
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const racers: Promise<unknown>[] = [Promise.resolve().then(() => service(action.data))];
      racers.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Service '${action.name}' timed out`), { code: "SERVICE_TIMEOUT" })), this.serviceTimeoutMs);
      }));
      if (signal) {
        racers.push(new Promise<never>((_, reject) => {
          if (signal.aborted) reject(Object.assign(new Error("Client.call was aborted"), { code: "ABORTED" }));
          else signal.addEventListener("abort", () => reject(Object.assign(new Error("Client.call was aborted"), { code: "ABORTED" })), { once: true });
        }));
      }
      const result = await Promise.race(racers);
      return { callbackID: action.callbackID, ok: true, result };
    } catch (error) {
      return { callbackID: action.callbackID, ok: false, error: errorPayload(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async send(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string>,
    phase: "initial" | "resume",
    signal?: AbortSignal,
  ): Promise<{ body: unknown; status: number; headers: Record<string, string> }> {
    let outgoing: HttpPluginRequest = {
      url,
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body,
      phase,
    };
    for (const plugin of this.plugins) {
      if (plugin.onRequest) {
        const changed = await plugin.onRequest(outgoing);
        if (changed) outgoing = changed;
      }
    }

    try {
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const fetchResponse = await fetch(outgoing.url, {
        method: outgoing.method,
        headers: outgoing.headers,
        body: JSON.stringify(outgoing.body),
        signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
      });
      const text = await fetchResponse.text();
      if (new TextEncoder().encode(text).length > this.maxResponseBytes) {
        throw Object.assign(new Error(`Response from ${outgoing.url} exceeds ${this.maxResponseBytes} bytes`), {
          code: "RESPONSE_TOO_LARGE",
        });
      }
      let responseBody: unknown;
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`Expected JSON from ${outgoing.url}, received non-JSON response (HTTP ${fetchResponse.status})`);
      }
      const meta: HttpPluginResponse = {
        url: outgoing.url,
        status: fetchResponse.status,
        headers: responseHeaders(fetchResponse),
        phase,
      };
      for (const plugin of this.plugins) {
        if (plugin.onResponse) {
          const changed = await plugin.onResponse(responseBody, meta);
          if (changed !== undefined) responseBody = changed;
        }
      }
      if (!fetchResponse.ok) {
        const detail = isObjectRecord(responseBody) && isObjectRecord(responseBody.error)
          ? String(responseBody.error.message ?? fetchResponse.statusText)
          : fetchResponse.statusText;
        throw new Error(`HTTP ${fetchResponse.status}: ${detail}`);
      }
      return { body: responseBody, status: fetchResponse.status, headers: meta.headers };
    } catch (error) {
      const converted = toError(error);
      for (const plugin of this.plugins) {
        await plugin.onError?.(converted, outgoing);
      }
      throw converted;
    }
  }
}

/** Create a contract-typed client: `const client = createClient(contract, options?)`. */
export function createClient<C extends ContractDefinition>(
  contract: C,
  options: NegotiationClientOptions = {},
): NegotiationClient<C> {
  return new NegotiationClient<C>({ ...options, contract });
}

export const Client = new NegotiationClient();
export const Server = new NegotiationServer();
