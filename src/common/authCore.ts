/**
 * Browser-safe shared pieces of the challenge-response authentication:
 * errors, time buckets, envelope/session types, and the built-in registry
 * of pure challenge functions `f(x) => y`.
 *
 * This module deliberately has no Node.js imports. `ClientAuthManager`
 * uses it together with the Web Crypto implementation in
 * `authCrypto.ts`, so the same client code can run in Node and in a
 * browser. The Web Crypto implementation is in `authCrypto.ts`.
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

/**
 * Current universal time as milliseconds since the Unix epoch.
 *
 * `Date.now()` is already timezone-independent (UTC-based): a local time
 * zone changes how an instant is displayed, never the epoch value used
 * by the auth negotiation. This named clock makes that explicit wherever
 * the managers need "now".
 */
export function utcNow(): number {
  return Date.now();
}

/** Current universal date/time as an ISO 8601 UTC string, e.g. 2026-10-14T12:00:00.000Z. */
export function utcDateTime(nowMs: number = utcNow()): string {
  return new Date(nowMs).toISOString();
}

/** `time\20000`: the integer time bucket used to derive encryption keys. */
export function getTimeBucket(nowMs: number, bucketMs = DEFAULT_AUTH_TIME_BUCKET_MS): number {
  return Math.floor(nowMs / bucketMs);
}

export interface AuthEnvelope {
  v: 1;
  alg: "AES-256-GCM-HKDF-SHA256";
  bucket: number;
  iv: string;
  tag: string;
  data: string;
}

export interface AuthCryptoOptions {
  nowMs?: number;
  bucketMs?: number;
  /** How many neighbouring buckets are accepted on decrypt (clock edge races). */
  toleranceBuckets?: number;
}

/**
 * Built-in challenge functions, registered identically on client and server.
 * Every function is pure and deterministic: `f(x) => y` over integers.
 */
export const AUTH_CHALLENGE_FUNCTIONS: Readonly<Record<string, (x: number) => number>> = Object.freeze({
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

export const AUTH_CHALLENGE_FUNCTION_NAMES: readonly string[] = Object.freeze(
  Object.keys(AUTH_CHALLENGE_FUNCTIONS),
);

/** Apply a challenge (a list of function names, in order) to `input`. */
export function applyChallenge(functionNames: readonly string[], input: number): number {
  let value = input;
  for (const name of functionNames) {
    const fn = AUTH_CHALLENGE_FUNCTIONS[name];
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

/** One entry in the server-side registry, created before a token is sent. */
export interface AuthRegistryEntry {
  token: string;
  uid: string;
  authId: string;
  issuedAt: number;
  expiresAt: number;
  acknowledged: boolean;
  acknowledgedAt?: number;
}

export interface AuthSession {
  token: string;
  uid: string;
  expiresAt: number;
}

export function isAuthRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
