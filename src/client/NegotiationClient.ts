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
    try {
      // Plugin chain: awaited in registration order before fetch. A plugin
      // halts the chain by returning false, throwing, or calling
      // haltRequest() — the request is never sent, the error is routed
      // through onError below, and client.call() rejects with it.
      for (const plugin of this.plugins) {
        if (plugin.onRequest) {
          const changed = await plugin.onRequest(outgoing);
          if (changed === false) throw new RequestHaltedError();
          if (changed) outgoing = changed;
        }
      }

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
