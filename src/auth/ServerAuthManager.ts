import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { NegotiationServer } from "../server.js";
import {
  applyChallenge,
  AuthError,
  decryptAuthPayload,
  encryptAuthPayload,
  isAuthRecord,
  AUTH_CHALLENGE_FUNCTION_NAMES,
  type AuthEnvelope,
  type AuthRegistryEntry,
  type ChallengeAnswerPayload,
  type ChallengePayload,
} from "./common.js";

export type PasswordLookup = (
  uid: string,
) => Promise<string | undefined> | string | undefined;

export interface ServerAuthManagerOptions {
  /** Per-user password source: `(uid) => password | undefined`. */
  getPassword: PasswordLookup;
  /** Maximum accepted client/server clock difference. Default 50 (ms). */
  maxClockSkewMs?: number;
  /** Width of the encryption time bucket (`time\50`). Default 50 (ms). */
  timeBucketMs?: number;
  /** Minimum fast time-sync requests before the server judges the clocks. Default 5. */
  minTimeSamples?: number;
  /** Number of challenge functions per challenge. Default 3. */
  challengeLength?: number;
  /** Pending handshake lifetime. Default 30_000 (ms). */
  authTimeoutMs?: number;
  /** Token lifetime in the registry. Default 900_000 (15 min). */
  tokenTtlMs?: number;
  maxBodyBytes?: number;
  /** Path of the auth endpoint when combined with a NegotiationServer. Default "/auth". */
  authPath?: string;
  /**
   * NegotiationServer to bind to (alternative to passing it as the first
   * constructor argument): auth requests go to `authPath`, all other
   * requests are delegated to that server, both share one HTTP server
   * (see listen()/attach()), and close() shuts both down.
   */
  server?: NegotiationServer;
  /** Clock override (testing). */
  now?: () => number;
  onError?: (error: Error, info: { authId?: string; phase: string }) => void;
}

interface PendingAuth {
  authId: string;
  createdAt: number;
  phase: "time" | "uid" | "challenge" | "token";
  timeSamplesMs: number[];
  uid?: string | undefined;
  password?: string | undefined;
  challenge?: (ChallengePayload & { expected: number }) | undefined;
  token?: string | undefined;
}

export interface AuthWireResult {
  status: number;
  body: Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const encoded = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(encoded));
  res.end(encoded);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const preparsed = (req as IncomingMessage & { body?: unknown }).body;
  if (preparsed !== undefined) return preparsed;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new AuthError("BODY_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AuthError("INVALID_JSON", "Request body must be valid JSON");
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

/**
 * Server side of the authentication flow ("authManager"):
 *
 *   begin -> time sync (many fast requests, clocks must agree within
 *   `maxClockSkewMs`, default 50 ms) -> uid request -> encrypted challenge
 *   (function names + data, AES-GCM under HKDF(pwd, time\50)) -> encrypted
 *   answer -> validate -> save token to the registry -> send token -> ack
 *   -> connection closed. A closed/expired session means the client runs a
 *   fresh auth process next time.
 *
 * Transport-agnostic core: `handleAuthMessage(body)`; HTTP is provided by
 * `requestHandler()` / `handleRequest()` / `listen()` / `attach()`, the same
 * pattern as NegotiationServer.
 */
export class ServerAuthManager {
  /** Registry of authenticated sessions, keyed by token. */
  readonly registry = new Map<string, AuthRegistryEntry>();
  /** The bound NegotiationServer, when one was supplied. */
  readonly negotiationServer: NegotiationServer | undefined;
  private readonly authPath: string;
  private readonly pending = new Map<string, PendingAuth>();
  private readonly getPassword: PasswordLookup;
  private readonly maxClockSkewMs: number;
  private readonly timeBucketMs: number;
  private readonly minTimeSamples: number;
  private readonly challengeLength: number;
  private readonly authTimeoutMs: number;
  private readonly tokenTtlMs: number;
  private readonly maxBodyBytes: number;
  private readonly now: () => number;
  private readonly onError: ServerAuthManagerOptions["onError"];
  private httpServerInstance: HttpServer | undefined;

  constructor(server: NegotiationServer, options: ServerAuthManagerOptions);
  constructor(options: ServerAuthManagerOptions);
  constructor(
    serverOrOptions: NegotiationServer | ServerAuthManagerOptions,
    maybeOptions?: ServerAuthManagerOptions,
  ) {
    const negotiationServer = serverOrOptions instanceof NegotiationServer
      ? serverOrOptions
      : serverOrOptions?.server;
    const options = (serverOrOptions instanceof NegotiationServer
      ? maybeOptions
      : serverOrOptions) as ServerAuthManagerOptions;
    this.negotiationServer = negotiationServer;
    this.authPath = options.authPath ?? "/auth";
    if (typeof options?.getPassword !== "function") {
      throw new TypeError("ServerAuthManager requires a getPassword(uid) lookup");
    }
    this.getPassword = options.getPassword;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 50;
    this.timeBucketMs = options.timeBucketMs ?? 50;
    this.minTimeSamples = options.minTimeSamples ?? 5;
    this.challengeLength = options.challengeLength ?? 3;
    this.authTimeoutMs = options.authTimeoutMs ?? 30_000;
    this.tokenTtlMs = options.tokenTtlMs ?? 900_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 65_536;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  /** The attached/owned HTTP server, if any (see NegotiationServer.attach). */
  get httpServer(): HttpServer | undefined {
    return this.httpServerInstance;
  }

  attach(httpServer: HttpServer): this {
    if (this.httpServerInstance && this.httpServerInstance !== httpServer) {
      throw new Error("ServerAuthManager is already attached to an HTTP server");
    }
    if (this.httpServerInstance === httpServer) return this;
    this.httpServerInstance = httpServer;
    const onError = (error: Error) => {
      try {
        this.onError?.(error, { phase: "http-server" });
      } catch { /* error hooks must never crash the server */ }
    };
    const onClose = () => {
      httpServer.off("error", onError);
      if (this.httpServerInstance === httpServer) this.httpServerInstance = undefined;
    };
    httpServer.on("error", onError);
    httpServer.once("close", onClose);
    return this;
  }

  async listen(port = 4000, host = "127.0.0.1"): Promise<void> {
    if (this.httpServerInstance) throw new Error("Auth server is already listening");
    const httpServer = createHttpServer(this.requestHandler());
    this.attach(httpServer);
    // Combined hosting: the NegotiationServer tracks the same HTTP server,
    // so its httpServer/close/error wiring is initialised too.
    this.negotiationServer?.attach(httpServer);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.pending.clear();
    // Combined hosting: shut the bound NegotiationServer down too (this
    // also closes the shared HTTP server and its store; it is idempotent,
    // so the HTTP close below becomes a no-op in that case).
    if (this.negotiationServer) await this.negotiationServer.close();
    const httpServer = this.httpServerInstance;
    this.httpServerInstance = undefined;
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections?.();
      });
    }
  }

  /**
   * HTTP handler. When a NegotiationServer is bound, requests to `authPath`
   * (default "/auth") run the auth flow and every other request is
   * delegated to that NegotiationServer, so one HTTP server serves both.
   * Standalone, every POST runs the auth flow (as before).
   */
  requestHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      const negotiationServer = this.negotiationServer;
      if (negotiationServer) {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path !== this.authPath) {
          void negotiationServer.handleRequest(req, res);
          return;
        }
      }
      void this.handleRequest(req, res);
    };
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST") {
        sendJson(res, 405, { type: "error", code: "METHOD_NOT_ALLOWED", message: "Use POST" });
        return;
      }
      const body = await readJsonBody(req, this.maxBodyBytes);
      const result = await this.handleAuthMessage(body);
      sendJson(res, result.status, result.body);
    } catch (error) {
      const authError = error instanceof AuthError
        ? error
        : new AuthError("AUTH_FAILED", error instanceof Error ? error.message : String(error));
      try {
        this.onError?.(authError, { phase: "request" });
      } catch { /* ignore */ }
      sendJson(res, 400, { type: "error", code: authError.code, message: authError.message });
    }
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

  /** Number of in-flight (not yet completed) handshakes. */
  getPendingCount(): number {
    this.cleanupExpiredPending();
    return this.pending.size;
  }

  /** Transport-agnostic handshake state machine (one message in, one out). */
  async handleAuthMessage(message: unknown): Promise<AuthWireResult> {
    this.cleanupExpiredPending();
    if (!isAuthRecord(message) || typeof message.type !== "string") {
      return this.failure(400, "INVALID_MESSAGE", "Auth message must be an object with a type");
    }

    switch (message.type) {
      case "begin": {
        const authId = randomUUID();
        this.pending.set(authId, {
          authId,
          createdAt: this.now(),
          phase: "time",
          timeSamplesMs: [],
        });
        return this.success({ type: "begin_ok", authId, serverTime: this.now() });
      }

      case "time": {
        const session = this.requirePending(message, "time");
        if (typeof message.clientTime !== "number") {
          return this.failure(400, "INVALID_TIME", "clientTime must be a number");
        }
        const serverTime = this.now();
        session.timeSamplesMs.push(serverTime - message.clientTime);
        return this.success({ type: "time_ack", authId: session.authId, serverTime });
      }

      case "time_commit": {
        const session = this.requirePending(message, "time");
        if (session.timeSamplesMs.length < this.minTimeSamples) {
          return this.failure(409, "TIME_SYNC_INCOMPLETE", `Expected at least ${this.minTimeSamples} time samples`);
        }
        if (typeof message.offsetMs !== "number") {
          return this.failure(400, "INVALID_TIME", "offsetMs must be a number");
        }
        // The server's own verdict uses its fastest (least-delayed) samples:
        // clocks must be identical within maxClockSkewMs, on both estimates.
        const observed = [...session.timeSamplesMs].sort((a, b) => Math.abs(a) - Math.abs(b));
        const fastest = observed.slice(0, Math.min(3, observed.length));
        const serverSkewMs = median(fastest);
        if (Math.abs(serverSkewMs) > this.maxClockSkewMs || Math.abs(message.offsetMs) > this.maxClockSkewMs) {
          this.pending.delete(session.authId);
          return this.failure(
            403,
            "CLOCK_SKEW",
            `Clock difference exceeds ${this.maxClockSkewMs} ms (server: ${serverSkewMs.toFixed(1)} ms, client: ${message.offsetMs.toFixed(1)} ms); connection closed`,
          );
        }
        session.phase = "uid";
        return this.success({ type: "uid_request", authId: session.authId, serverSkewMs });
      }

      case "uid": {
        const session = this.requirePending(message, "uid");
        if (typeof message.uid !== "string" || !message.uid) {
          return this.failure(400, "INVALID_UID", "uid must be a non-empty string");
        }
        const password = await this.getPassword(message.uid);
        if (password === undefined) {
          this.pending.delete(session.authId);
          return this.failure(403, "UNKNOWN_UID", `Unknown uid: ${message.uid}`);
        }
        session.uid = message.uid;
        session.password = password;

        const challenge: ChallengePayload = {
          data: randomInt(-20, 51),
          challenge: Array.from(
            { length: this.challengeLength },
            () => AUTH_CHALLENGE_FUNCTION_NAMES[randomInt(AUTH_CHALLENGE_FUNCTION_NAMES.length)] as string,
          ),
          nonce: randomUUID(),
        };
        session.challenge = {
          ...challenge,
          expected: applyChallenge(challenge.challenge, challenge.data),
        };
        session.phase = "challenge";
        return this.success({
          type: "challenge",
          authId: session.authId,
          // encryption({data, challenge}, pwd + time\50)
          payload: encryptAuthPayload(challenge, password, {
            nowMs: this.now(),
            bucketMs: this.timeBucketMs,
          }),
        });
      }

      case "answer": {
        const session = this.requirePending(message, "challenge");
        if (!session.challenge || !session.password || !session.uid) {
          return this.failure(409, "NO_CHALLENGE", "No challenge is pending for this session");
        }
        let answer: ChallengeAnswerPayload;
        try {
          answer = decryptAuthPayload<ChallengeAnswerPayload>(
            message.payload as AuthEnvelope,
            session.password,
            { nowMs: this.now(), bucketMs: this.timeBucketMs },
          );
        } catch (error) {
          this.pending.delete(session.authId);
          return this.failure(403, "DECRYPT_FAILED", error instanceof Error ? error.message : "Could not decrypt answer");
        }
        const valid = answer.nonce === session.challenge.nonce && answer.result === session.challenge.expected;
        // The password and challenge are single-use, whatever happens next.
        session.password = undefined;
        session.challenge = undefined;
        if (!valid) {
          this.pending.delete(session.authId);
          return this.failure(403, "CHALLENGE_FAILED", "Challenge result is not valid; connection closed");
        }

        // Auth is considered successful *now*: save to the registry first,
        // only then send the token to the client.
        const token = randomBytes(32).toString("base64url");
        const entry: AuthRegistryEntry = {
          token,
          uid: session.uid,
          authId: session.authId,
          issuedAt: this.now(),
          expiresAt: this.now() + this.tokenTtlMs,
          acknowledged: false,
        };
        this.registry.set(token, entry);
        session.token = token;
        session.phase = "token";
        return this.success({
          type: "token",
          authId: session.authId,
          token,
          uid: session.uid,
          expiresAt: entry.expiresAt,
        });
      }

      case "ack": {
        const session = this.requirePending(message, "token");
        const entry = typeof message.token === "string" ? this.registry.get(message.token) : undefined;
        if (!entry || entry.authId !== session.authId || entry.token !== session.token) {
          return this.failure(403, "INVALID_TOKEN", "Ack does not match the registered token");
        }
        entry.acknowledged = true;
        entry.acknowledgedAt = this.now();
        this.pending.delete(session.authId); // handshake connection is closed
        return this.success({ type: "closed", authId: session.authId, ok: true });
      }

      case "abort": {
        if (typeof message.authId === "string") this.pending.delete(message.authId);
        return this.success({ type: "closed", ok: true });
      }

      default:
        return this.failure(400, "UNKNOWN_MESSAGE", `Unknown auth message type: ${message.type}`);
    }
  }

  private requirePending(
    message: Record<string, unknown>,
    phase: PendingAuth["phase"],
  ): PendingAuth {
    const authId = typeof message.authId === "string" ? message.authId : "";
    const session = this.pending.get(authId);
    if (!session) throw new AuthError("UNKNOWN_AUTH_SESSION", "Unknown or expired auth session; start a new auth process");
    if (session.phase !== phase) {
      throw new AuthError("UNEXPECTED_STEP", `Auth session is at step '${session.phase}', not '${phase}'`);
    }
    return session;
  }

  private cleanupExpiredPending(): void {
    const cutoff = this.now() - this.authTimeoutMs;
    for (const [authId, session] of this.pending) {
      if (session.createdAt < cutoff) this.pending.delete(authId);
    }
  }

  private success(body: Record<string, unknown>): AuthWireResult {
    return { status: 200, body };
  }

  private failure(status: number, code: string, message: string): AuthWireResult {
    return { status, body: { type: "error", code, message } };
  }
}

/** Alias matching the original design name. */
export const AuthManager = ServerAuthManager;
