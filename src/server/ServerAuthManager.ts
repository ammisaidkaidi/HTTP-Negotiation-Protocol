import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import { NegotiationServer } from "./NegotiationServer.js";
import {
  applyChallenge,
  AuthError,
  AUTH_CHALLENGE_FUNCTION_NAMES,
  DEFAULT_AUTH_MAX_CLOCK_SKEW_MS,
  DEFAULT_AUTH_TIME_BUCKET_MS,
  utcDateTime,
  utcNow,
  type AuthEnvelope,
  type AuthRegistryEntry,
  type ChallengeAnswerPayload,
  type ChallengePayload,
} from "../common/authCore.js";
import {
  decryptAuthPayloadAsync,
  encryptAuthPayloadAsync,
} from "../common/authCrypto.js";
import {
  generateRandomToken,
  randomInt,
  randomUuid,
} from "../common/webCrypto.js";

export type PasswordLookup = (
  uid: string,
) => Promise<string | undefined> | string | undefined;

export interface ServerAuthManagerOptions {
  /** Per-user password source: `(uid) => password | undefined`. */
  getPassword: PasswordLookup;
  /** Maximum accepted client/server clock difference. Default 20,000 (ms). */
  maxClockSkewMs?: number;
  /** Width of the encryption time bucket (`time\20000`). Default 20,000 (ms). */
  timeBucketMs?: number;
  /** Number of fast time-sync negotiation rounds. Default 5. */
  timeSamples?: number;
  /** Number of challenge functions per challenge. Default 3. */
  challengeLength?: number;
  /** Token lifetime in the registry. Default 900_000 (15 min). */
  tokenTtlMs?: number;
  /** Negotiation route that runs the auth flow. Default "/auth". */
  authPath?: string;
  /**
   * NegotiationServer to bind to (alternative to passing it as the first
   * constructor argument). The auth flow is registered as a negotiation
   * route on it (`this.server`); hosting is delegated to an HTTP server
   * attached to it — NegotiationServer has no `listen()` of its own.
   */
  server?: NegotiationServer;
  /** Clock override (testing). */
  now?: () => number;
  onError?: (error: Error, info: { authId?: string; phase: string }) => void;
}

/**
 * Server side of the authentication flow ("authManager"), implemented as
 * an auth *negotiation* on top of the library itself. Registering this
 * manager adds one negotiation route (`authPath`, default "/auth") to the
 * bound NegotiationServer. A `ClientAuthManager` runs it with one logical
 * `NegotiationClient.call()`, inside which this manager:
 *
 *   1. (begin) the client's call starts the auth job;
 *   2. asks the client for its time over several fast negotiation rounds
 *      (`auth.time` client service) — at the end, the client and server
 *      clocks must be identical within `maxClockSkewMs` (default 20,000 ms),
 *      otherwise the job fails and the connection is closed;
 *   3. requests the uid (`auth.getUid` client service) and resolves the
 *      password through the configured lookup;
 *   4. sends back a challenge — a list of built-in `f(x) => y` function
 *      names plus input data — encrypted as
 *      `encryption({data, challenge}, pwd + time\20000)`
 *      (AES-256-GCM, key = HKDF(password, time bucket)), via the
 *      `auth.solveChallenge` client service;
 *   5. receives the client's encrypted answer the same way, decrypts and
 *      validates it: auth succeeds or fails here;
 *   6. on success, FIRST saves the token to the registry (that save is
 *      what marks the auth successful), THEN sends the token to the
 *      client via the `auth.acceptToken` client service;
 *   7. the client stores the token and returns its ack from that service;
 *      the job then ends and the connection is closed. A closed/expired
 *      session means the client runs a fresh auth negotiation next time.
 *
 * This class never creates an HTTP server: `attach()`,
 * `requestHandler()`, and `close()` delegate to the bound
 * NegotiationServer (`this.server`), and `listen()` starts the HTTP
 * server already attached to it.
 */
export class ServerAuthManager {
  /** Registry of authenticated sessions, keyed by token. */
  readonly registry = new Map<string, AuthRegistryEntry>();
  /** The bound NegotiationServer (`this.server`), when one was supplied. */
  readonly server: NegotiationServer | undefined;

  /** Backwards-compatible alias for {@link server}. */
  get negotiationServer(): NegotiationServer | undefined {
    return this.server;
  }

  private readonly authPath: string;
  private readonly getPassword: PasswordLookup;
  private readonly maxClockSkewMs: number;
  private readonly timeBucketMs: number;
  private readonly timeSamples: number;
  private readonly challengeLength: number;
  private readonly tokenTtlMs: number;
  private readonly now: () => number;
  private readonly onError: ServerAuthManagerOptions["onError"];
  private startupTimeMs: number;

  constructor(server: NegotiationServer, options: ServerAuthManagerOptions);
  constructor(options: ServerAuthManagerOptions);
  constructor(
    serverOrOptions: NegotiationServer | ServerAuthManagerOptions,
    maybeOptions?: ServerAuthManagerOptions,
  ) {
    const server = serverOrOptions instanceof NegotiationServer
      ? serverOrOptions
      : serverOrOptions?.server;
    const options = (serverOrOptions instanceof NegotiationServer
      ? maybeOptions
      : serverOrOptions) as ServerAuthManagerOptions;
    if (typeof options?.getPassword !== "function") {
      throw new TypeError("ServerAuthManager requires a getPassword(uid) lookup");
    }
    this.server = server;
    this.authPath = options.authPath ?? "/auth";
    this.getPassword = options.getPassword;
    this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_AUTH_MAX_CLOCK_SKEW_MS;
    this.timeBucketMs = options.timeBucketMs ?? DEFAULT_AUTH_TIME_BUCKET_MS;
    this.timeSamples = options.timeSamples ?? 5;
    this.challengeLength = options.challengeLength ?? 3;
    this.tokenTtlMs = options.tokenTtlMs ?? 900_000;
    this.now = options.now ?? utcNow;
    this.startupTimeMs = this.now();
    this.onError = options.onError;

    // The auth flow is a negotiation route on the bound server.
    this.server?.handle(this.authPath, async () => this.runAuthNegotiation());
  }

  /**
   * Universal date/time (UTC, ISO 8601) at which this auth server was
   * started. Recorded at construction and reset whenever `listen()`
   * starts serving, so it always reflects the latest server startup.
   */
  get startedAtUtc(): string {
    return utcDateTime(this.startupTimeMs);
  }

  /** Current universal date/time (UTC, ISO 8601) on the auth server clock. */
  get universalTime(): string {
    return utcDateTime(this.now());
  }

  /** The bound NegotiationServer's HTTP server, if it has one. */
  get httpServer(): HttpServer | undefined {
    return this.server?.httpServer;
  }

  /** Delegate HTTP attachment to the bound NegotiationServer. */
  attach(httpServer: HttpServer): this {
    // Hosting startup through an external HTTP server also resets the
    // server time reference to universal time.
    this.startupTimeMs = this.now();
    this.requireServer().attach(httpServer);
    return this;
  }

  /**
   * Start the HTTP server attached to the bound NegotiationServer, so it
   * serves the auth route together with every other negotiation route:
   *
   *   const http = createHttpServer(authServer.requestHandler());
   *   authServer.attach(http);
   *   await authServer.listen(4000);
   *
   * NegotiationServer deliberately has no `listen()` method, and this
   * manager never creates an HTTP server either — the application owns
   * it. If the attached server is already listening, this resolves
   * immediately.
   */
  async listen(port = 4000, host = "127.0.0.1"): Promise<void> {
    // Server startup: reset the server time reference to universal time.
    this.startupTimeMs = this.now();
    const httpServer = this.requireServer().httpServer;
    if (!httpServer) {
      throw new Error(
        "ServerAuthManager.listen requires an HTTP server attached to the bound NegotiationServer: " +
        "create one with createHttpServer(authServer.requestHandler()), call authServer.attach(httpServer), " +
        "then authServer.listen(port, host)",
      );
    }
    if (httpServer.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(port, host, () => {
        httpServer.off("error", onError);
        resolve();
      });
    });
  }

  /** Close the bound NegotiationServer (HTTP server, jobs, and its store). */
  async close(): Promise<void> {
    if (this.server) await this.server.close();
  }

  /** The bound NegotiationServer's request handler (auth route included). */
  requestHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return this.requireServer().requestHandler();
  }

  /** Handle one request through the bound NegotiationServer. */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.requireServer().handleRequest(req, res);
  }

  /** Look a token up in the registry; expired tokens are evicted and rejected. */
  validateToken(token: string): AuthRegistryEntry | undefined {
    const entry = this.registry.get(token);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.registry.delete(token);
      return undefined;
    }
    return entry;
  }

  revokeToken(token: string): boolean {
    return this.registry.delete(token);
  }

  private requireServer(): NegotiationServer {
    if (!this.server) {
      throw new TypeError(
        "ServerAuthManager requires a bound NegotiationServer (this.server) for HTTP hosting",
      );
    }
    return this.server;
  }

  /** One full auth negotiation, run as a NegotiationServer route handler. */
  private async runAuthNegotiation(): Promise<Record<string, unknown>> {
    const server = this.requireServer();
    const authId = randomUuid();
    try {
      // -- Time sync: many fast negotiation rounds. Each `auth.time` ask is
      //    one round trip; the fastest sample gives the clock offset.
      let bestOffsetMs = Number.POSITIVE_INFINITY;
      let bestRoundTripMs = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.timeSamples; i++) {
        const before = this.now();
        const clientTime: unknown = await server.ask.auth.time();
        const after = this.now();
        if (typeof clientTime !== "number") {
          throw new AuthError("INVALID_TIME", "auth.time client service must return a number");
        }
        const roundTripMs = after - before;
        const offsetMs = clientTime - (before + after) / 2; // client - server
        if (roundTripMs < bestRoundTripMs) {
          bestRoundTripMs = roundTripMs;
          bestOffsetMs = offsetMs;
        }
      }
      if (Math.abs(bestOffsetMs) > this.maxClockSkewMs) {
        throw new AuthError(
          "CLOCK_SKEW",
          `Clock difference ${bestOffsetMs.toFixed(1)} ms exceeds ${this.maxClockSkewMs} ms; connection closed`,
        );
      }

      // -- The server requests the uid; the client sends it.
      const uid: unknown = await server.ask.auth.getUid();
      if (typeof uid !== "string" || !uid) {
        throw new AuthError("INVALID_UID", "auth.getUid client service must return a non-empty string");
      }
      const password = await this.getPassword(uid);
      if (password === undefined) {
        throw new AuthError("UNKNOWN_UID", `Unknown uid: ${uid}`);
      }

      // -- Challenge, sent back encrypted with pwd + time\20000. The client
      //    resolves it inside its auth.solveChallenge service and the
      //    encrypted answer comes back as that service's result.
      const challenge: ChallengePayload = {
        data: randomInt(-20, 51),
        challenge: Array.from(
          { length: this.challengeLength },
          () => AUTH_CHALLENGE_FUNCTION_NAMES[randomInt(0, AUTH_CHALLENGE_FUNCTION_NAMES.length)] as string,
        ),
        nonce: randomUuid(),
      };
      const expected = applyChallenge(challenge.challenge, challenge.data);
      const encryptedAnswer: unknown = await server.ask.auth.solveChallenge(
        await encryptAuthPayloadAsync(challenge, password, { nowMs: this.now(), bucketMs: this.timeBucketMs }),
      );
      let answer: ChallengeAnswerPayload;
      try {
        answer = await decryptAuthPayloadAsync<ChallengeAnswerPayload>(
          encryptedAnswer as AuthEnvelope,
          password,
          { nowMs: this.now(), bucketMs: this.timeBucketMs },
        );
      } catch (error) {
        throw new AuthError(
          "DECRYPT_FAILED",
          error instanceof Error ? error.message : "Could not decrypt challenge answer",
        );
      }
      if (answer.nonce !== challenge.nonce || answer.result !== expected) {
        throw new AuthError("CHALLENGE_FAILED", "Challenge result is not valid; connection closed");
      }

      // -- Auth success: save the token to the registry FIRST, only then
      //    send it to the client (via auth.acceptToken, whose return value
      //    is the client's ack).
      const token = await generateRandomToken();
      const entry: AuthRegistryEntry = {
        token,
        uid,
        authId,
        issuedAt: this.now(),
        expiresAt: this.now() + this.tokenTtlMs,
        acknowledged: false,
      };
      this.registry.set(token, entry);
      try {
        const ack: unknown = await server.ask.auth.acceptToken({
          token,
          uid,
          expiresAt: entry.expiresAt,
        });
        if (!ack || typeof ack !== "object" || (ack as { ack?: unknown }).ack !== true) {
          throw new AuthError("ACK_FAILED", "Client did not acknowledge the token");
        }
      } catch (error) {
        this.registry.delete(token); // never acknowledged: not a valid session
        throw error;
      }
      entry.acknowledged = true;
      entry.acknowledgedAt = this.now();

      // Returning the result ends the job; the connection is closed.
      return { authenticated: true, uid, expiresAt: entry.expiresAt, clockOffsetMs: bestOffsetMs };
    } catch (error) {
      try {
        this.onError?.(error instanceof Error ? error : new Error(String(error)), { authId, phase: "negotiation" });
      } catch { /* error hooks must never break the flow */ }
      throw error;
    }
  }
}

/** Alias matching the original design name. */
export const AuthManager = ServerAuthManager;
