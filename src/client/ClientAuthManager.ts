import { NegotiationClient } from "./NegotiationClient.js";
import type { ClientPlugin } from "../common/negotiations.js";
import {
  applyChallenge,
  AuthError,
  DEFAULT_AUTH_TIME_BUCKET_MS,
  utcNow,
  type AuthEnvelope,
  type AuthSession,
  type ChallengeAnswerPayload,
  type ChallengePayload,
} from "../common/authCore.js";
import {
  decryptAuthPayloadAsync,
  encryptAuthPayloadAsync,
} from "../common/authCrypto.js";

export interface ClientAuthManagerOptions {
  /** Negotiation auth route URL, e.g. `http://127.0.0.1:4000/auth`. */
  authUrl: string;
  uid: string;
  password: string;
  /** Width of the encryption time bucket (`time\20000`). Default 20,000 (ms). */
  timeBucketMs?: number;
  /** Clock override (testing). */
  now?: () => number;
  /**
   * NegotiationClient to bind to (alternative to passing it as the first
   * constructor argument). The auth services are registered on it, the
   * auth negotiation runs through it, and after a successful
   * authenticate() it automatically sends
   * `authorization: Bearer <token>` (and `x-auth-uid`) on every
   * negotiation call; after close() it stops sending them.
   */
  client?: NegotiationClient;
}

/**
 * Client side of the authentication flow ("clientAuth"), implemented as
 * an auth *negotiation*: `authenticate()` runs one logical
 * `NegotiationClient.call()` to the server's auth route, and answers the
 * server's asks through client services registered on that client:
 *
 *   auth.time            -> current client time (asked over several fast
 *                           rounds for the 20,000 ms clock check)
 *   auth.getUid          -> the uid the server requests
 *   auth.solveChallenge  -> decrypts the challenge sent by the server
 *                           (encryption({data, challenge}, pwd + time\20000)),
 *                           applies the named `f(x) => y` functions in
 *                           order, and returns the answer encrypted the
 *                           same way
 *   auth.acceptToken     -> receives the token (already saved in the
 *                           server registry at that point), stores it,
 *                           and returns the ack; the job then ends and
 *                           the connection is closed
 *
 * The token is kept in memory until it expires or `close()` is called;
 * after that a fresh auth negotiation is required.
 */
export class ClientAuthManager {
  /** The bound NegotiationClient, when one was supplied. */
  readonly negotiationClient: NegotiationClient | undefined;
  private readonly authUrl: string;
  private readonly uid: string;
  private readonly password: string;
  private readonly timeBucketMs: number;
  private readonly now: () => number;
  private session: AuthSession | undefined;
  private authInProgress = false;
  /** Clock offset (client - server, ms) measured by the server in the last auth. */
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
    this.timeBucketMs = options.timeBucketMs ?? DEFAULT_AUTH_TIME_BUCKET_MS;
    this.now = options.now ?? utcNow;
    if (client) this.bindToNegotiationClient(client);
  }

  /** Current in-memory token, if authenticated and not expired. */
  get token(): string | undefined {
    return this.session && this.now() <= this.session.expiresAt ? this.session.token : undefined;
  }

  isAuthenticated(): boolean {
    return this.token !== undefined;
  }

  /** Forget the token (connection closed): the next authenticate() re-runs the full negotiation. */
  close(): void {
    this.session = undefined;
    this.lastClockOffsetMs = undefined;
  }

  /**
   * Run the auth negotiation. Returns the stored session if a previous
   * token is still valid, unless `force` is set — a closed connection /
   * new process always runs the negotiation again.
   */
  async authenticate(options: { force?: boolean } = {}): Promise<AuthSession> {
    if (!options.force && this.token && this.session) return this.session;
    const client = this.negotiationClient;
    if (!client) {
      throw new TypeError(
        "ClientAuthManager.authenticate requires a bound NegotiationClient; " +
        "pass one as the first constructor argument",
      );
    }
    this.session = undefined;
    this.authInProgress = true;
    try {
      // One logical call = the whole auth negotiation (begin). Inside it,
      // the server asks for time samples, the uid, the challenge answer,
      // and finally delivers the token (see the auth.* services below).
      const result = await client.call({
        url: this.authUrl,
        data: { begin: true },
      }) as { clockOffsetMs?: unknown } | null;
      if (!this.session) {
        throw new AuthError("INVALID_RESPONSE", "Auth negotiation ended without the client accepting a token");
      }
      if (typeof result?.clockOffsetMs === "number") {
        this.lastClockOffsetMs = result.clockOffsetMs;
      }
      return this.session;
    } catch (error) {
      this.session = undefined;
      throw error;
    } finally {
      this.authInProgress = false;
    }
  }

  /**
   * Bind to a NegotiationClient: registers the auth client services the
   * server asks for during the negotiation, and installs a plugin that
   * injects the current auth token into every negotiation request made
   * through that client. The plugin reads the token live, so
   * re-authentication and close() take effect without re-registering.
   */
  private bindToNegotiationClient(client: NegotiationClient): void {
    client.use({
      // Asked repeatedly, fast: each answer is one negotiation round.
      "auth.time": async () => {
        this.assertAuthInProgress();
        return this.now();
      },
      // The server requests the uid; the client sends it.
      "auth.getUid": async () => {
        this.assertAuthInProgress();
        return this.uid;
      },
      // Receives encryption({data, challenge}, pwd + time\20000), resolves
      // the function list, and sends the answer back encrypted the same way.
      "auth.solveChallenge": async (envelope: AuthEnvelope) => {
        this.assertAuthInProgress();
        const challenge = await decryptAuthPayloadAsync<ChallengePayload>(envelope, this.password, {
          nowMs: this.now(),
          bucketMs: this.timeBucketMs,
        });
        const answer: ChallengeAnswerPayload = {
          result: applyChallenge(challenge.challenge, challenge.data),
          nonce: challenge.nonce,
        };
        return encryptAuthPayloadAsync(answer, this.password, {
          nowMs: this.now(),
          bucketMs: this.timeBucketMs,
        });
      },
      // Receives the token (already saved in the server registry), stores
      // it, and returns the ack the server is waiting for.
      "auth.acceptToken": async (data: { token?: unknown; uid?: unknown; expiresAt?: unknown }) => {
        this.assertAuthInProgress();
        if (typeof data?.token !== "string" || !data.token) {
          throw new AuthError("INVALID_TOKEN", "Server sent an invalid token");
        }
        this.session = {
          token: data.token,
          uid: typeof data.uid === "string" ? data.uid : this.uid,
          expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : 0,
        };
        return { ack: true };
      },
    });

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

  private assertAuthInProgress(): void {
    if (!this.authInProgress) {
      throw new AuthError("NO_AUTH_IN_PROGRESS", "Auth services only answer during an auth negotiation");
    }
  }
}

/** Short alias matching the original design name. */
export const ClientAuth = ClientAuthManager;
