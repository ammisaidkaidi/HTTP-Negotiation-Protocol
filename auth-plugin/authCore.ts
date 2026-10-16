/**
 * Shared core of the auth plugin framework: errors, universal-time buckets,
 * challenge functions, payload/session types, and the abstract customization
 * points (clock, password provider) implemented by both sides.
 *
 * Browser-safe: no Node.js imports. Time is always UTC epoch milliseconds —
 * `Date.now()` is timezone-independent; the named clock makes that explicit
 * and lets production code inject a synchronized/test clock.
 */

export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Default maximum accepted client/server clock difference: 20,000 ms. */
export const DEFAULT_AUTH_MAX_CLOCK_SKEW_MS = 20_000;

/** Default width of the encryption time bucket (`time\20000`): 20,000 ms. */
export const DEFAULT_AUTH_TIME_BUCKET_MS = 20_000;

/** Default token lifetime in the registry: 900,000 ms (15 minutes). */
export const DEFAULT_AUTH_TOKEN_TTL_MS = 900_000;

// ---------------------------------------------------------------------------
// Abstract customization point: clock
// ---------------------------------------------------------------------------

/** Clock abstraction — inject a synchronized or fake clock in production/tests. */
export interface Clock {
  now(): number;
}

/** Default clock: universal time (UTC epoch milliseconds). */
export const systemClock: Clock = { now: () => Date.now() };

/** `time\20000`: the integer time bucket used to derive encryption keys. */
export function getTimeBucket(nowMs: number, bucketMs = DEFAULT_AUTH_TIME_BUCKET_MS): number {
  return Math.floor(nowMs / bucketMs);
}

// ---------------------------------------------------------------------------
// Challenge functions f(x) => y — identical on client and server. Production
// deployments may replace/augment the set (identically on BOTH sides) via
// the `challengeFunctions` option of createServerAuth/createClientAuth.
// ---------------------------------------------------------------------------

export type ChallengeFunction = (x: number) => number;

export const AUTH_CHALLENGE_FUNCTIONS: Readonly<Record<string, ChallengeFunction>> = Object.freeze({
  add1: (x) => x + 1,
  add7: (x) => x + 7,
  subtract3: (x) => x - 3,
  double: (x) => x * 2,
  triple: (x) => x * 3,
  multiply5: (x) => x * 5,
  square: (x) => x * x,
  negate: (x) => -x,
  xor42: (x) => x ^ 42,
  plus100: (x) => x + 100,
});

/** Apply a challenge (a list of function names, in order) to `input`. */
export function applyChallenge(
  functionNames: readonly string[],
  input: number,
  functions: Readonly<Record<string, ChallengeFunction>> = AUTH_CHALLENGE_FUNCTIONS,
): number {
  let value = input;
  for (const name of functionNames) {
    const fn = functions[name];
    if (!fn) throw new AuthError("UNKNOWN_CHALLENGE_FUNCTION", `Unknown challenge function: ${name}`);
    value = fn(value);
  }
  return value;
}

export interface ChallengePayload {
  data: number;
  challenge: string[];
  nonce: string;
}

export interface ChallengeAnswerPayload {
  result: number;
  nonce: string;
}

/** One entry in the server-side token registry, created before a token is sent. */
export interface AuthRegistryEntry {
  token: string;
  uid: string;
  authId: string;
  issuedAt: number;
  expiresAt: number;
  acknowledged: boolean;
  acknowledgedAt?: number;
}

/** Client-side session, stored through a SessionStorage (see stores.ts). */
export interface AuthSession {
  token: string;
  uid: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Abstract customization point: password source (server side)
// ---------------------------------------------------------------------------

export type PasswordLookup = (uid: string) => Promise<string | undefined> | string | undefined;

/**
 * Password provider abstraction. The default is a plain lookup function;
 * production code implements this against a database / secret manager.
 */
export interface PasswordProvider {
  getPassword(uid: string): Promise<string | undefined> | string | undefined;
}

/** Adapt a `(uid) => password` function to a PasswordProvider. */
export function passwordProviderFromLookup(lookup: PasswordLookup): PasswordProvider {
  return { getPassword: lookup };
}
