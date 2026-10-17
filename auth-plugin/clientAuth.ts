/**
 * Client half of the auth plugin framework.
 *
 *   const clientAuth = createClientAuth({ authUrl, client });
 *   await clientAuth.login({ uid: "user1", pwd: "correct-horse" });
 *
 * Design (mirrors the original ClientAuthManager binding, as a plugin):
 * - The `NegotiationClient` is bound at construction (options.client); the
 *   constructor registers the `auth.*` services and this plugin itself on
 *   that client — no manual `client.use(...)` needed.
 * - Credentials are NOT options and NOT readonly: `uid`/`pwd` are supplied
 *   per login, `login({ uid, pwd })`, and kept in mutable protected fields
 *   so subclasses (and `getUid()`/`getPwd()` overrides) can source them
 *   from anywhere (form, vault, SSO...).
 * - `onAuthStateChanged(state)` reports the session lifecycle.
 *
 * This class is itself a `ClientPlugin`: its `onRequest` attaches
 * `authorization: Bearer <token>` (+ `x-auth-uid`) to every request once
 * logged in. The session lives in a `SessionStorage` (default: memory).
 */
import { NegotiationClient } from "../src/client/index.js";
import type {
  ClientCallRequest,
  ClientPlugin,
  HttpPluginRequest,
} from "../src/common/negotiations.js";
import {
  applyChallenge,
  AUTH_CHALLENGE_FUNCTIONS,
  AuthError,
  DEFAULT_AUTH_TIME_BUCKET_MS,
  systemClock,
  type AuthSession,
  type ChallengeAnswerPayload,
  type ChallengeFunction,
  type ChallengePayload,
  type Clock,
} from "./authCore.js";
import {
  decryptAuthPayload,
  encryptAuthPayload,
  type AuthEnvelope,
} from "./authCrypto.js";
import { MemorySessionStorage, type SessionStorage } from "./stores.js";

/** Session lifecycle states reported through `onAuthStateChanged`. */
export enum AuthState {
  Unauthenticated = "unauthenticated",
  Authenticating = "authenticating",
  Authenticated = "authenticated",
  Closed = "closed",
}

export interface ClientAuthOptions {
  /** Negotiation auth route URL, e.g. `http://127.0.0.1:4000/auth`. */
  authUrl: string;
  /** The NegotiationClient this plugin binds to (services + plugin are registered on it). */
  client: NegotiationClient;
  /** Session storage. Default: MemorySessionStorage. */
  storage?: SessionStorage;
  /** Clock abstraction. Default: systemClock (UTC epoch ms). */
  clock?: Clock;
  /** Challenge function set — must match the server's set exactly. */
  challengeFunctions?: Readonly<Record<string, ChallengeFunction>>;
  /** Width of the encryption time bucket (`time\20000`). Default 20,000 (ms). */
  timeBucketMs?: number;
  /** Fired on every session state transition (see AuthState). */
  onAuthStateChanged?: (state: AuthState) => void;
  /**
   * Automatic re-authentication (default true): when a call fails with the
   * server's AUTH_REQUIRED error, the plugin captures it, runs the login
   * process itself (with the credentials kept from the last login), and
   * retries the call once — transparently for the caller.
   */
  autoLogin?: boolean;
}

export interface LoginOptions {
  force?: boolean;
  uid?: string;
  pwd?: string;
}

export class ClientAuthPlugin implements ClientPlugin {
  /** The `auth.*` client services (auto-registered on the bound client). */
  readonly services: Record<string, (data: any) => Promise<unknown>>;
  /** The NegotiationClient this plugin is bound to. */
  readonly client: NegotiationClient;

  protected readonly authUrl: string;
  protected readonly storage: SessionStorage;
  protected readonly clock: Clock;
  protected readonly challengeFunctions: Readonly<Record<string, ChallengeFunction>>;
  protected readonly timeBucketMs: number;
  protected readonly onAuthStateChanged: ClientAuthOptions["onAuthStateChanged"];
  protected readonly autoLogin: boolean;

  /** Current credentials — mutable, supplied via login({ uid, pwd }); never options. */
  protected uid: string | undefined;
  protected password: string | undefined;

  private state: AuthState = AuthState.Unauthenticated;
  private authInProgress = false;
  private clockOffsetMs: number | undefined;

  constructor(options: ClientAuthOptions) {
    if (!options?.authUrl) throw new TypeError("createClientAuth requires authUrl");
    if (!options.client) throw new TypeError("createClientAuth requires a NegotiationClient (options.client)");
    this.authUrl = options.authUrl;
    this.client = options.client;
    this.storage = options.storage ?? new MemorySessionStorage();
    this.clock = options.clock ?? systemClock;
    this.challengeFunctions = options.challengeFunctions ?? AUTH_CHALLENGE_FUNCTIONS;
    this.timeBucketMs = options.timeBucketMs ?? DEFAULT_AUTH_TIME_BUCKET_MS;
    this.onAuthStateChanged = options.onAuthStateChanged;
    this.autoLogin = options.autoLogin ?? true;

    this.services = {
      // Asked repeatedly, fast: each answer is one negotiation round.
      "auth.time": async () => {
        this.assertAuthInProgress();
        return this.clock.now();
      },
      // The server requests the uid; the client sends it.
      "auth.getUid": async () => {
        this.assertAuthInProgress();
        return this.getUid();
      },
      // Receives encryption({data, challenge}, pwd + time\20000), resolves
      // the function list, and sends the answer back encrypted the same way.
      "auth.solveChallenge": async (envelope: AuthEnvelope) => {
        this.assertAuthInProgress();
        const password = await this.getPwd();
        const challenge = await decryptAuthPayload<ChallengePayload>(envelope, password, {
          clock: this.clock,
          bucketMs: this.timeBucketMs,
        });
        const answer: ChallengeAnswerPayload = {
          result: applyChallenge(challenge.challenge, challenge.data, this.challengeFunctions),
          nonce: challenge.nonce,
        };
        return encryptAuthPayload(answer, password, {
          clock: this.clock,
          bucketMs: this.timeBucketMs,
        });
      },
      // Asked by a HELD job (see ServerAuthPlugin.protect): the server is
      // waiting at its guard point for this client to log in. Runs the
      // whole login negotiation as a nested client.call() — the outer job
      // stays suspended meanwhile — then answers, so the server executes
      // its continuation and the outer request proceeds.
      "auth.login": async () => {
        if (!this.uid || !this.password) {
          throw new AuthError(
            "MISSING_CREDENTIALS",
            "Server asked for login, but no credentials are known (call login({ uid, pwd }) once first)",
          );
        }
        const session = await this.login({ force: true });
        return { authenticated: true, uid: session.uid };
      },
      // Receives the token (already saved in the server registry), stores
      // it, and returns the ack the server is waiting for.
      "auth.acceptToken": async (data: { token?: unknown; uid?: unknown; expiresAt?: unknown }) => {
        this.assertAuthInProgress();
        if (typeof data?.token !== "string" || !data.token) {
          throw new AuthError("INVALID_TOKEN", "Server sent an invalid token");
        }
        this.storage.write({
          token: data.token,
          uid: typeof data.uid === "string" ? data.uid : (this.uid ?? ""),
          expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : 0,
        });
        return { ack: true };
      },
    };

    // Bind to the NegotiationClient: services the server asks for, plus
    // this plugin itself for token injection on every request.
    this.client.use(this.services);
    this.client.use(this);

    // Capture the server's AUTH_REQUIRED answer: run the login process,
    // then continue the caller's process by retrying the call once.
    if (this.autoLogin) {
      const originalCall = this.client.call.bind(this.client);
      this.client.call = (request: ClientCallRequest) => this.callWithAutoAuth(originalCall, request);
    }
  }

  // -- Automatic re-authentication ----------------------------------------------
  //
  // client.call() -> onRequest injects the session token (if present) ->
  // fetch -> server checks auth: valid -> normal work; invalid -> the call
  // fails with code AUTH_REQUIRED. The plugin captures that message here,
  // starts the auth process until success (login negotiation with the
  // credentials kept from the last login), then retries the original call
  // once, so the caller's process simply continues.
  //
  // Note: the server already ended the original job when it sent the auth
  // error, so the retry is a NEW job with the same request — transparent
  // for the caller, who just sees one awaited client.call() succeed.

  private async callWithAutoAuth(
    originalCall: (request: ClientCallRequest) => Promise<unknown>,
    request: ClientCallRequest,
  ): Promise<unknown> {
    try {
      return await originalCall(request);
    } catch (error) {
      if (
        this.authInProgress // the login negotiation itself is never intercepted
        || !this.isAuthRequired(error)
        || this.isAuthRoute(request)
        || !this.uid
        || !this.password // no credentials kept: cannot log in automatically
      ) {
        throw error;
      }
      this.storage.clear();
      this.setState(AuthState.Unauthenticated);
      await this.login({ force: true }); // auth process, until success
      return originalCall(request); // continue the caller's process (once)
    }
  }

  private isAuthRequired(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === "AUTH_REQUIRED";
  }

  private isAuthRoute(request: ClientCallRequest): boolean {
    try {
      return new URL(request.url).toString() === new URL(this.authUrl).toString();
    } catch {
      return false;
    }
  }

  // -- Credential supply (customization points) -------------------------------

  /** Current uid. Default: the one given to login({ uid }); override to source it elsewhere. */
  protected async getUid(): Promise<string> {
    if (!this.uid) throw new AuthError("MISSING_UID", "No uid: call login({ uid, pwd }) first");
    return this.uid;
  }

  /** Current password. Default: the one given to login({ pwd }); override to source it elsewhere. */
  protected async getPwd(): Promise<string> {
    if (!this.password) throw new AuthError("MISSING_PASSWORD", "No password: call login({ uid, pwd }) first");
    return this.password;
  }

  // -- ClientPlugin: token injection ------------------------------------------

  /** Headers added to every request once logged in (customization point). */
  protected decorateHeaders(
    headers: Record<string, string>,
    token: string,
    uid: string,
  ): Record<string, string> {
    return { ...headers, authorization: `Bearer ${token}`, "x-auth-uid": uid };
  }

  onRequest(request: HttpPluginRequest): HttpPluginRequest | void {
    const session = this.storage.read();
    const token = this.getToken();
    if (!token || !session) return; // unauthenticated: leave headers untouched
    return { ...request, headers: this.decorateHeaders({ ...request.headers }, token, session.uid) };
  }

  // -- Session API --------------------------------------------------------------

  /** Current auth lifecycle state. */
  get authState(): AuthState {
    return this.state;
  }

  private setState(state: AuthState): void {
    if (this.state === state) return;
    this.state = state;
    try {
      this.onAuthStateChanged?.(state);
    } catch { /* state listeners must never break the flow */ }
  }

  /** Current token, if logged in and not expired. */
  getToken(): string | undefined {
    const session = this.storage.read();
    return session && this.clock.now() <= session.expiresAt ? session.token : undefined;
  }

  isAuthenticated(): boolean {
    return this.getToken() !== undefined;
  }

  /** Clock offset (client - server, ms) measured by the server in the last login. */
  get lastClockOffsetMs(): number | undefined {
    return this.clockOffsetMs;
  }

  /** Forget the token and credentials: the next login() re-runs the full negotiation. */
  close(): void {
    this.storage.clear();
    this.uid = undefined;
    this.password = undefined;
    this.clockOffsetMs = undefined;
    this.setState(AuthState.Closed);
  }

  /**
   * Run the login negotiation through the bound NegotiationClient: one
   * logical `client.call()` to the auth route. Credentials are supplied
   * here — `login({ uid, pwd })` — not in the constructor options; once
   * given, they are kept for later `login({ force: true })` re-auth until
   * `close()`. Returns the stored session if a previous token is still
   * valid, unless `force` is set.
   */
  async login(options: LoginOptions = {}): Promise<AuthSession> {
    if (options.uid !== undefined) this.uid = options.uid;
    if (options.pwd !== undefined) this.password = options.pwd;

    const existing = this.storage.read();
    if (!options.force && this.getToken() && existing) return existing;

    this.storage.clear();
    this.setState(AuthState.Authenticating);
    this.authInProgress = true;
    try {
      const result = await this.client.call({
        url: this.authUrl,
        data: { begin: true },
      }) as { clockOffsetMs?: unknown } | null;
      const session = this.storage.read();
      if (!session) {
        throw new AuthError("INVALID_RESPONSE", "Auth negotiation ended without the client accepting a token");
      }
      if (typeof result?.clockOffsetMs === "number") this.clockOffsetMs = result.clockOffsetMs;
      this.setState(AuthState.Authenticated);
      return session;
    } catch (error) {
      this.storage.clear();
      this.setState(AuthState.Unauthenticated);
      throw error;
    } finally {
      this.authInProgress = false;
    }
  }

  private assertAuthInProgress(): void {
    if (!this.authInProgress) {
      throw new AuthError("NO_AUTH_IN_PROGRESS", "Auth services only answer during an auth negotiation");
    }
  }
}

/** Factory: `const auth = createClientAuth({ authUrl, client }); await auth.login({ uid, pwd });` */
export function createClientAuth(options: ClientAuthOptions): ClientAuthPlugin {
  return new ClientAuthPlugin(options);
}
