/**
 * Server half of the auth plugin framework.
 *
 * `createServerAuth(options)` returns a `ServerAuthPlugin` — a genuine
 * `ServerPlugin` (guard) plus the login negotiation route:
 *
 *   const auth = createServerAuth({ getPassword });
 *   auth.register(server);            // plugin + POST /auth login route
 *   server.plugin(auth);              // (register already does this)
 *
 * The guard runs in `onCallStart`: it extracts the Bearer token (override
 * `extractToken` to customize), checks it against the `TokenStore`, and
 * fails the call with `AUTH_REQUIRED` before any route handler runs.
 * Subclass `ServerAuthPlugin` (or pass options) to customize extraction,
 * public paths, challenge shape, token generation, and failure handling.
 *
 * The login route itself is one logical negotiation (same flow as the
 * original ServerAuthManager): time sync -> uid -> encrypted challenge ->
 * registry-first token + ack.
 */
import {
  NegotiationServer,
  type ServerPlugin,
} from "../src/server/index.js";
import type {
  RouteHandler,
  ServerRequest,
} from "../src/common/negotiations.js";
import {
  applyChallenge,
  AUTH_CHALLENGE_FUNCTIONS,
  AuthError,
  DEFAULT_AUTH_MAX_CLOCK_SKEW_MS,
  DEFAULT_AUTH_TIME_BUCKET_MS,
  DEFAULT_AUTH_TOKEN_TTL_MS,
  passwordProviderFromLookup,
  systemClock,
  type ChallengeAnswerPayload,
  type ChallengeFunction,
  type ChallengePayload,
  type Clock,
  type PasswordLookup,
  type PasswordProvider,
} from "./authCore.js";
import {
  decryptAuthPayload,
  encryptAuthPayload,
  type AuthEnvelope,
} from "./authCrypto.js";
import { MemoryTokenStore, type TokenStore } from "./stores.js";
import { generateRandomToken, randomInt, randomUuid } from "../src/common/webCrypto.js";

export interface ServerAuthOptions {
  /** Per-user password source: `(uid) => password | undefined`. */
  getPassword?: PasswordLookup;
  /** Password provider abstraction (takes precedence over `getPassword`). */
  passwords?: PasswordProvider;
  /** Token registry storage. Default: MemoryTokenStore (single process). */
  store?: TokenStore;
  /** Clock abstraction. Default: systemClock (UTC epoch ms). */
  clock?: Clock;
  /** Token factory. Default: Web Crypto random token. */
  tokenGenerator?: () => Promise<string> | string;
  /** Challenge function set — must match the client's set exactly. */
  challengeFunctions?: Readonly<Record<string, ChallengeFunction>>;
  /** Maximum accepted client/server clock difference. Default 20,000 (ms). */
  maxClockSkewMs?: number;
  /** Width of the encryption time bucket (`time\20000`). Default 20,000 (ms). */
  timeBucketMs?: number;
  /** Number of fast time-sync negotiation rounds. Default 5. */
  timeSamples?: number;
  /** Number of challenge functions per challenge. Default 3. */
  challengeLength?: number;
  /** Token lifetime in the registry. Default 900,000 (15 min). */
  tokenTtlMs?: number;
  /** Negotiation route that runs the login flow. Default "/auth". */
  authPath?: string;
  /** Routes reachable without a token (besides the auth route itself). */
  publicPaths?: string[];
  onError?: (error: Error, info: { authId?: string; phase: string }) => void;
  /** Observability hook fired after a successful login. */
  onLoginSuccess?: (info: { uid: string; authId: string; clockOffsetMs: number }) => void;
}

export class ServerAuthPlugin implements ServerPlugin {
  readonly name = "auth";
  /** The login route path (default "/auth"). */
  readonly path: string;

  protected readonly passwords: PasswordProvider;
  protected readonly store: TokenStore;
  protected readonly clock: Clock;
  protected readonly tokenGenerator: () => Promise<string> | string;
  protected readonly challengeFunctions: Readonly<Record<string, ChallengeFunction>>;
  protected readonly maxClockSkewMs: number;
  protected readonly timeBucketMs: number;
  protected readonly timeSamples: number;
  protected readonly challengeLength: number;
  protected readonly tokenTtlMs: number;
  protected readonly publicPaths: ReadonlySet<string>;
  protected readonly onError: ServerAuthOptions["onError"];
  protected readonly onLoginSuccess: ServerAuthOptions["onLoginSuccess"];
  /** Paths registered via protect(): the guard defers to their wrapper. */
  protected readonly protectedPaths = new Set<string>();
  private boundServer: NegotiationServer | undefined;

  constructor(options: ServerAuthOptions = {}) {
    const passwords = options.passwords
      ?? (options.getPassword ? passwordProviderFromLookup(options.getPassword) : undefined);
    if (!passwords) {
      throw new TypeError("createServerAuth requires getPassword(uid) or a passwords provider");
    }
    this.passwords = passwords;
    this.store = options.store ?? new MemoryTokenStore();
    this.clock = options.clock ?? systemClock;
    this.tokenGenerator = options.tokenGenerator ?? generateRandomToken;
    this.challengeFunctions = options.challengeFunctions ?? AUTH_CHALLENGE_FUNCTIONS;
    this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_AUTH_MAX_CLOCK_SKEW_MS;
    this.timeBucketMs = options.timeBucketMs ?? DEFAULT_AUTH_TIME_BUCKET_MS;
    this.timeSamples = options.timeSamples ?? 5;
    this.challengeLength = options.challengeLength ?? 3;
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_AUTH_TOKEN_TTL_MS;
    this.path = options.authPath ?? "/auth";
    this.publicPaths = new Set(options.publicPaths ?? []);
    this.onError = options.onError;
    this.onLoginSuccess = options.onLoginSuccess;
  }

  // -- Customization points (override in a subclass if options are not enough)

  /** Extract the bearer token from a request. Default: `authorization: Bearer <t>`. */
  protected extractToken(request: ServerRequest): string | undefined {
    const header = request.headers.authorization;
    return typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : undefined;
  }

  /** Whether `path` is reachable without a token (auth route is always public). */
  protected isPublicPath(path: string): boolean {
    return path === this.path || this.publicPaths.has(path);
  }

  /** Failure behaviour for unauthenticated calls. Default: throw AUTH_REQUIRED. */
  protected onAuthFailed(path: string): never {
    throw new AuthError("AUTH_REQUIRED", `Authentication required for ${path}`);
  }

  // -- ServerPlugin guard -----------------------------------------------------

  async onCallStart({ path, request }: { path: string; request: ServerRequest }): Promise<void> {
    if (this.isPublicPath(path) || this.protectedPaths.has(path)) return;
    const token = this.extractToken(request);
    if (!token || !(await this.validateToken(token))) this.onAuthFailed(path);
  }

  // -- Registry API -----------------------------------------------------------

  /** Look a token up in the store; expired tokens are evicted and rejected. */
  async validateToken(token: string) {
    const entry = await this.store.get(token);
    if (!entry) return undefined;
    if (this.clock.now() > entry.expiresAt) {
      await this.store.delete(token);
      return undefined;
    }
    return entry;
  }

  async revokeToken(token: string): Promise<boolean> {
    return this.store.delete(token);
  }

  // -- Wiring -----------------------------------------------------------------

  /** Installs the guard plugin and the login route on a NegotiationServer. */
  register(server: NegotiationServer): this {
    this.boundServer = server;
    server.plugin(this);
    server.handle(this.path, this.loginHandler);
    return this;
  }

  /**
   * Register a route that requires auth — with HELD-REQUEST semantics:
   *
   *   client.call() -> onRequest injects token (if any) -> server guard
   *   point: token valid -> the handler runs normally. Token missing or
   *   invalid -> instead of failing, the job is HELD at this point and
   *   the server asks the client to log in inside this same job
   *   (`auth.login` client service: the client runs the whole login
   *   negotiation as a nested call, then answers). When the login
   *   succeeds, the server verifies the issued session in its store and
   *   executes the continuation — your handler — so the original
   *   client.call() simply receives the handler's result. If the client
   *   cannot log in (no credentials, bad password), the held job fails
   *   with AUTH_REQUIRED exactly like the plain guard.
   *
   * Must be called after register(server). Routes registered this way
   * are skipped by the onCallStart guard (the wrapper does the check,
   * so it can hold the job instead of failing it).
   */
  protect(path: string, handler: RouteHandler): this {
    const server = this.boundServer;
    if (!server) throw new TypeError("ServerAuthPlugin.protect: call register(server) first");
    this.protectedPaths.add(path);
    server.handle(path, async (request) => {
      const token = this.extractToken(request);
      if (token && (await this.validateToken(token))) {
        return handler(request); // authenticated: continue normally
      }

      // Not authenticated: hold this job HERE and ask the client to log
      // in (in-job). The code after this await is the callback that
      // continues processing the request once auth succeeds.
      let uid: unknown;
      try {
        const loginResult = await server.ask.auth.login({ reason: "AUTH_REQUIRED", path });
        uid = (loginResult as { uid?: unknown } | null)?.uid;
      } catch {
        uid = undefined; // client could not / would not log in
      }
      const entry = typeof uid === "string" ? await this.store.findByUid(uid) : undefined;
      if (!entry || this.clock.now() > entry.expiresAt || !entry.acknowledged) {
        this.onAuthFailed(path);
      }

      // Auth success -> execute the callback: continue the held request.
      return handler(request);
    });
    return this;
  }

  /** The login negotiation as a route handler (bound by `register`). */
  private readonly loginHandler: RouteHandler = async () => {
    const server = this.boundServer;
    if (!server) throw new TypeError("ServerAuthPlugin: call register(server) before serving");
    const authId = randomUuid();
    const now = () => this.clock.now();
    try {
      // -- Time sync: many fast rounds; the fastest sample gives the offset.
      let bestOffsetMs = Number.POSITIVE_INFINITY;
      let bestRoundTripMs = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.timeSamples; i++) {
        const before = now();
        const clientTime: unknown = await server.ask.auth.time();
        const after = now();
        if (typeof clientTime !== "number") {
          throw new AuthError("INVALID_TIME", "auth.time client service must return a number");
        }
        const roundTripMs = after - before;
        if (roundTripMs < bestRoundTripMs) {
          bestRoundTripMs = roundTripMs;
          bestOffsetMs = clientTime - (before + after) / 2; // client - server
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
      const password = await this.passwords.getPassword(uid);
      if (password === undefined) {
        throw new AuthError("UNKNOWN_UID", `Unknown uid: ${uid}`);
      }

      // -- Challenge, encrypted with pwd + time\20000; encrypted answer back.
      const names = Object.keys(this.challengeFunctions);
      const challenge: ChallengePayload = {
        data: randomInt(-20, 51),
        challenge: Array.from(
          { length: this.challengeLength },
          () => names[randomInt(0, names.length)] as string,
        ),
        nonce: randomUuid(),
      };
      const expected = applyChallenge(challenge.challenge, challenge.data, this.challengeFunctions);
      const encryptedAnswer: unknown = await server.ask.auth.solveChallenge(
        await encryptAuthPayload(challenge, password, { clock: this.clock, bucketMs: this.timeBucketMs }),
      );
      let answer: ChallengeAnswerPayload;
      try {
        answer = await decryptAuthPayload<ChallengeAnswerPayload>(
          encryptedAnswer as AuthEnvelope,
          password,
          { clock: this.clock, bucketMs: this.timeBucketMs },
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

      // -- Save the token to the registry FIRST, only then send it; the
      //    client's ack (auth.acceptToken) completes the login.
      const token = await this.tokenGenerator();
      const entry = {
        token,
        uid,
        authId,
        issuedAt: now(),
        expiresAt: now() + this.tokenTtlMs,
        acknowledged: false,
      };
      await this.store.save(entry);
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
        await this.store.delete(token); // never acknowledged: not a valid session
        throw error;
      }
      entry.acknowledged = true;
      entry.acknowledgedAt = now();
      await this.store.save(entry);
      this.onLoginSuccess?.({ uid, authId, clockOffsetMs: bestOffsetMs });

      return { authenticated: true, uid, expiresAt: entry.expiresAt, clockOffsetMs: bestOffsetMs };
    } catch (error) {
      try {
        this.onError?.(error instanceof Error ? error : new Error(String(error)), { authId, phase: "negotiation" });
      } catch { /* error hooks must never break the flow */ }
      throw error;
    }
  };
}

/** Factory: `const auth = createServerAuth({ getPassword }); auth.register(server);` */
export function createServerAuth(options: ServerAuthOptions): ServerAuthPlugin {
  return new ServerAuthPlugin(options);
}
