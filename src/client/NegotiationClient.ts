/**
 * Client half of the protocol: NegotiationClient, plugins/services, and
 * createClient(). Extracted verbatim from the former single-file
 * protocol.ts (v1.8).
 */
import {
  errorPayload,
  isObjectRecord,
  RequestHaltedError,
  toError,
  type ActionResult,
  type ClientAction,
  type ClientCallRequest,
  type ClientPlugin,
  type ClientService,
  type ClientServices,
  type ContractDefinition,
  type EmptyContract,
  type HttpPluginRequest,
  type HttpPluginResponse,
  type ProvideFor,
} from "../common/negotiations.js";

export { haltRequest, RequestHaltedError, type ClientCallRequest } from "../common/negotiations.js";

/**
 * What plugins may see of a negotiation envelope: the asked actions are
 * stripped. Plugins cannot observe asks/responseAsks — ask payloads and
 * service results never reach plugin hooks.
 */
function isEnvelope(value: unknown): value is Record<string, unknown> & { actions: unknown[] } {
  return isObjectRecord(value) && value.protocol === 1 && Array.isArray(value.actions);
}

function redactEnvelopeForPlugins(body: unknown): unknown {
  return isEnvelope(body) ? { ...body, actions: [] } : body;
}

/**
 * Merge a plugin's returned body into the real response. Plugins only ever
 * saw `actions: []`, so whatever they return can change other fields but never
 * replace the asks the client has to execute.
 */
function applyPluginResponse(current: unknown, changed: unknown): unknown {
  if (!isEnvelope(current)) return changed;
  if (!isObjectRecord(changed)) return current;
  return { ...current, ...changed, actions: current.actions };
}

const PLUGIN_HOOKS = ["onRequest", "onResponse", "onError"] as const;

function assertPluginHooks(plugin: ClientPlugin): ClientPlugin {
  for (const hook of PLUGIN_HOOKS) {
    if (plugin[hook] !== undefined && typeof plugin[hook] !== "function") {
      throw new TypeError(`Client plugin hook '${hook}' must be a function`);
    }
  }
  // A plain object literal given to use() with a hook is a whole plugin, so any
  // other function-valued entry in it would be silently dropped. Reject that.
  // Class-based plugins (instances with their own state and callbacks) are exempt.
  const hookNames: readonly string[] = PLUGIN_HOOKS;
  const isLiteral = Object.getPrototypeOf(plugin) === Object.prototype;
  const strays = !isLiteral ? [] : Object.keys(plugin).filter(
    (key) => !hookNames.includes(key) && typeof (plugin as Record<string, unknown>)[key] === "function",
  );
  if (strays.length > 0) {
    throw new TypeError(
      `Client plugin object also defines service(s) ${strays.join(", ")}; register services with provide() instead`,
    );
  }
  return plugin;
}

/**
 * Read a response body as text, cancelling the stream as soon as it exceeds
 * `maxBytes`, so an oversized response is never buffered in full.
 */
async function readLimitedText(response: Response, maxBytes: number, url: string): Promise<string> {
  const tooLarge = () =>
    Object.assign(new Error(`Response from ${url} exceeds ${maxBytes} bytes`), { code: "RESPONSE_TOO_LARGE" });
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function responseHeaders(res: Response): Record<string, string> {
  const output: Record<string, string> = {};
  res.headers.forEach((value, key) => (output[key] = value));
  return output;
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
        this.plugins.push(assertPluginHooks(plugin as ClientPlugin));
      }
    } else if (isObjectRecord(pluginOrServices) &&
      ("onRequest" in pluginOrServices || "onResponse" in pluginOrServices || "onError" in pluginOrServices)) {
      this.plugins.push(assertPluginHooks(pluginOrServices as ClientPlugin));
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
    const entries = Object.entries(services as ClientServices);
    for (const [name, service] of entries) {
      if (this.contract?.client && !Object.hasOwn(this.contract.client, name)) {
        throw new TypeError(`Client service '${name}' is not defined in the contract`);
      }
      if (typeof service !== "function") throw new TypeError(`Client service '${name}' must be a function`);
    }
    // Always services. Unlike use(), never guess whether a map is a plugin, so a
    // service named onError or onRequest is still registered.
    for (const [name, service] of entries) this.services.set(name, service);
    return this;
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
      const resumeTarget = new URL(protocol.resumeUrl, initialUrl);
      // The resume request carries the caller's headers and the resume token,
      // so it must never leave the origin the call started on.
      if (resumeTarget.origin !== initialUrl.origin) {
        throw new Error(`Negotiation resume URL must be on the same origin as the request (${initialUrl.origin})`);
      }
      const resumeUrl = resumeTarget.toString();
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
    let onAbort: (() => void) | undefined;
    try {
      const racers: Promise<unknown>[] = [Promise.resolve().then(() => service(action.data))];
      racers.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Service '${action.name}' timed out`), { code: "SERVICE_TIMEOUT" })), this.serviceTimeoutMs);
      }));
      if (signal) {
        racers.push(new Promise<never>((_, reject) => {
          const abortError = () => Object.assign(new Error("Client.call was aborted"), { code: "ABORTED" });
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          onAbort = () => reject(abortError());
          signal.addEventListener("abort", onAbort, { once: true });
        }));
      }
      const result = await Promise.race(racers);
      return { callbackID: action.callbackID, ok: true, result };
    } catch (error) {
      return { callbackID: action.callbackID, ok: false, error: errorPayload(error) };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
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
    // Ask privacy: on resume rounds the body carries service RESULTS, which
    // plugins must not observe. Plugins see a redacted request (they can
    // still observe timing/headers and halt); any body a plugin returns
    // for a resume is discarded — the real results are sent untouched.
    const isResume = phase === "resume";
    let pluginRequest: HttpPluginRequest = isResume
      ? { ...outgoing, body: { __redacted: "negotiation results are hidden from plugins" } }
      : outgoing;
    try {
      // Plugin chain: awaited in registration order before fetch. A plugin
      // halts the chain by returning false, throwing, or calling
      // haltRequest() — the request is never sent, the error is routed
      // through onError below, and client.call() rejects with it.
      for (const plugin of this.plugins) {
        if (plugin.onRequest) {
          const changed = await plugin.onRequest(pluginRequest);
          if (changed === false) throw new RequestHaltedError();
          if (changed) pluginRequest = changed;
        }
      }
      outgoing = isResume ? { ...pluginRequest, body } : pluginRequest;

      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const fetchResponse = await fetch(outgoing.url, {
        method: outgoing.method,
        headers: outgoing.headers,
        body: JSON.stringify(outgoing.body),
        signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
      });
      const text = await readLimitedText(fetchResponse, this.maxResponseBytes, outgoing.url);
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
          // Plugins see the envelope with asked actions stripped (privacy).
          const changed = await plugin.onResponse(redactEnvelopeForPlugins(responseBody), meta);
          if (changed !== undefined) responseBody = applyPluginResponse(responseBody, changed);
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
        await plugin.onError?.(converted, isResume ? pluginRequest : outgoing);
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
