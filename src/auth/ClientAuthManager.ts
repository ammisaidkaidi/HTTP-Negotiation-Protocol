import { NegotiationClient } from "../client.js";
import type { ClientPlugin } from "../common.js";
import {
  applyChallenge,
  AuthError,
  decryptAuthPayload,
  encryptAuthPayload,
  type AuthEnvelope,
  type AuthSession,
  type ChallengeAnswerPayload,
  type ChallengePayload,
} from "./common.js";

export interface ClientAuthManagerOptions {
  /** Server auth endpoint, e.g. `http://127.0.0.1:4000/auth`. */
  authUrl: string;
  uid: string;
  password: string;
  /** Maximum accepted client/server clock difference. Default 50 (ms). */
  maxClockSkewMs?: number;
  /** Width of the encryption time bucket (`time\50`). Default 50 (ms). */
  timeBucketMs?: number;
  /** Number of fast time-sync requests. Default 5 (server minimum is also 5). */
  timeSamples?: number;
  requestTimeoutMs?: number;
  /** Clock override (testing). */
  now?: () => number;
  fetchImpl?: typeof fetch;
  /**
   * NegotiationClient to bind to (alternative to passing it as the first
   * constructor argument). After a successful authenticate(), this client
   * automatically sends `authorization: Bearer <token>` (and `x-auth-uid`)
   * on every negotiation call; after close() it stops sending them.
   */
  client?: NegotiationClient;
}

interface TimeSample {
  offsetMs: number;
  roundTripMs: number;
}

/**
 * Client side of the authentication flow ("clientAuth"):
 *
 *   send begin -> time sync (many fast requests; both clocks must agree
 *   within `maxClockSkewMs`, default 50 ms, else the connection is closed)
 *   -> server requests uid -> send uid -> receive the challenge encrypted
 *   under HKDF(pwd, time\50) -> resolve it (apply the named functions in
 *   order) -> send the encrypted answer -> server validates and, on
 *   success, saves the token to its registry and sends it -> send ack ->
 *   connection closed. The token is kept in memory until it expires or
 *   `close()` is called; after that a fresh auth process is required.
 */
export class ClientAuthManager {
  /** The bound NegotiationClient, when one was supplied. */
  readonly negotiationClient: NegotiationClient | undefined;
  private readonly authUrl: string;
  private readonly uid: string;
  private readonly password: string;
  private readonly maxClockSkewMs: number;
  private readonly timeBucketMs: number;
  private readonly timeSamples: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private session: AuthSession | undefined;
  /** Clock offset estimated by the last successful time sync (server - client). */
  lastClockOffsetMs: number | undefined;

  constructor(client: NegotiationClient, options: ClientAuthManagerOptions);
  constructor(options: ClientAuthManagerOptions);
  constructor(
    clientOrOptions: NegotiationClient | ClientAuthManagerOptions,
    maybeOptions?: ClientAuthManagerOptions,
  ) {
    const client = clientOrOptions instanceof NegotiationClient
      ? clientOrOptions
      : clientOrOptions?.client;
    const options = (clientOrOptions instanceof NegotiationClient
      ? maybeOptions
      : clientOrOptions) as ClientAuthManagerOptions;
    this.negotiationClient = client;
    if (!options?.authUrl) throw new TypeError("ClientAuthManager requires authUrl");
    if (!options.uid) throw new TypeError("ClientAuthManager requires uid");
    if (!options.password) throw new TypeError("ClientAuthManager requires password");
    this.authUrl = options.authUrl;
    this.uid = options.uid;
    this.password = options.password;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 50;
    this.timeBucketMs = options.timeBucketMs ?? 50;
    this.timeSamples = options.timeSamples ?? 5;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (client) this.bindToNegotiationClient(client);
  }

  /**
   * Bind to a NegotiationClient: installs a plugin that injects the current
   * auth token into every negotiation request made through that client.
   * The plugin reads the token live, so re-authentication and close() take
   * effect without re-registering anything.
   */
  private bindToNegotiationClient(client: NegotiationClient): void {
    const plugin: ClientPlugin = {
      onRequest: (request) => {
        const token = this.token;
        if (!token) return; // unauthenticated: leave headers untouched
        return {
          ...request,
          headers: {
            ...request.headers,
            authorization: `Bearer ${token}`,
            "x-auth-uid": this.uid,
          },
        };
      },
    };
    client.use(plugin);
  }

  /** Current in-memory token, if authenticated and not expired. */
  get token(): string | undefined {
    return this.session && this.now() <= this.session.expiresAt ? this.session.token : undefined;
  }

  isAuthenticated(): boolean {
    return this.token !== undefined;
  }

  /** Forget the token (connection closed): the next authenticate() re-runs the full process. */
  close(): void {
    this.session = undefined;
    this.lastClockOffsetMs = undefined;
  }

  /**
   * Run the full auth process. Returns the stored session if a previous
   * token is still valid, unless `force` is set — a closed connection /
   * new process always runs the handshake again.
   */
  async authenticate(options: { force?: boolean } = {}): Promise<AuthSession> {
    if (!options.force && this.token && this.session) return this.session;
    this.session = undefined;

    // 1) Begin.
    const begin = await this.post({ type: "begin" });
    const authId = String(begin.authId ?? "");
    if (!authId) throw new AuthError("INVALID_RESPONSE", "Server did not return an authId");

    try {
      // 2) Time sync: many fast requests; estimate offset NTP-style from
      //    the fastest (least-delayed) round trip.
      const samples: TimeSample[] = [];
      for (let i = 0; i < this.timeSamples; i++) {
        const sentAt = this.now();
        const ack = await this.post({ type: "time", authId, clientTime: sentAt });
        const receivedAt = this.now();
        const serverTime = Number(ack.serverTime);
        samples.push({
          offsetMs: serverTime - (sentAt + receivedAt) / 2,
          roundTripMs: receivedAt - sentAt,
        });
      }
      samples.sort((a, b) => a.roundTripMs - b.roundTripMs);
      const best = samples[0] as TimeSample;
      this.lastClockOffsetMs = best.offsetMs;
      if (Math.abs(best.offsetMs) > this.maxClockSkewMs) {
        throw new AuthError(
          "CLOCK_SKEW",
          `Clock difference ${best.offsetMs.toFixed(1)} ms exceeds ${this.maxClockSkewMs} ms; connection closed`,
        );
      }
      // Server makes its own verdict from its samples, then requests the uid.
      await this.post({ type: "time_commit", authId, offsetMs: best.offsetMs });

      // 3) uid, as requested by the server.
      const challengeMessage = await this.post({ type: "uid", authId, uid: this.uid });

      // 4) Resolve the encrypted challenge: decrypt with pwd + time\50,
      //    apply the named functions in order to `data`.
      const challenge = decryptAuthPayload<ChallengePayload>(
        challengeMessage.payload as AuthEnvelope,
        this.password,
        { nowMs: this.now(), bucketMs: this.timeBucketMs },
      );
      const answer: ChallengeAnswerPayload = {
        result: applyChallenge(challenge.challenge, challenge.data),
        nonce: challenge.nonce,
      };

      // 5) Send the answer back, encrypted the same way.
      const tokenMessage = await this.post({
        type: "answer",
        authId,
        payload: encryptAuthPayload(answer, this.password, {
          nowMs: this.now(),
          bucketMs: this.timeBucketMs,
        }),
      });

      // 6) Server has already saved this token to its registry (that is
      //    what makes the auth successful); keep it, then ack + close.
      const session: AuthSession = {
        token: String(tokenMessage.token ?? ""),
        uid: String(tokenMessage.uid ?? this.uid),
        expiresAt: Number(tokenMessage.expiresAt ?? 0),
      };
      if (!session.token) throw new AuthError("INVALID_RESPONSE", "Server did not return a token");
      this.session = session;
      await this.post({ type: "ack", authId, token: session.token });
      return session;
    } catch (error) {
      this.session = undefined;
      // Tell the server to drop the pending handshake, if it still exists.
      try {
        await this.post({ type: "abort", authId });
      } catch { /* the session may already be gone */ }
      throw error;
    }
  }

  private async post(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.authUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new AuthError("AUTH_TRANSPORT", error instanceof Error ? error.message : String(error));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AuthError("INVALID_RESPONSE", `Auth server returned non-JSON (HTTP ${response.status})`);
    }
    if (!response.ok || (typeof body === "object" && body !== null && (body as { type?: unknown }).type === "error")) {
      const record = (body ?? {}) as { code?: unknown; message?: unknown };
      throw new AuthError(
        typeof record.code === "string" ? record.code : "AUTH_FAILED",
        typeof record.message === "string" ? record.message : `Auth request failed (HTTP ${response.status})`,
      );
    }
    return body as Record<string, unknown>;
  }
}

/** Short alias matching the original design name. */
export const ClientAuth = ClientAuthManager;
