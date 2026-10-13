import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Shared building blocks for the challenge-response authentication in
 * src/auth/: time synchronisation (50 ms by default), AES-256-GCM payloads
 * keyed by HKDF(password, time-bucket), and a built-in registry of pure
 * challenge functions `f(x) => y`.
 */

export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** `time\50`: the integer time bucket used to derive encryption keys. */
export function getTimeBucket(nowMs: number, bucketMs = 50): number {
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

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** Key = HKDF-SHA256(password, salt, info = `auth-v1:bucket:<bucket>`). */
export function deriveAuthKey(password: string, bucket: number): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(password, "utf8"),
      Buffer.from("http-negotiation-auth-v1", "utf8"),
      Buffer.from(`auth-v1:bucket:${bucket}`, "utf8"),
      32,
    ),
  );
}

export interface AuthCryptoOptions {
  nowMs?: number;
  bucketMs?: number;
  /** How many neighbouring buckets are accepted on decrypt (clock edge races). */
  toleranceBuckets?: number;
}

/** Encrypt `payload` as JSON under a key derived from `password + time\50`. */
export function encryptAuthPayload(
  payload: unknown,
  password: string,
  options: AuthCryptoOptions = {},
): AuthEnvelope {
  const bucketMs = options.bucketMs ?? 50;
  const bucket = getTimeBucket(options.nowMs ?? Date.now(), bucketMs);
  const key = deriveAuthKey(password, bucket);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    alg: "AES-256-GCM-HKDF-SHA256",
    bucket,
    iv: toBase64Url(iv),
    tag: toBase64Url(cipher.getAuthTag()),
    data: toBase64Url(ciphertext),
  };
}

/** Decrypt an envelope produced by {@link encryptAuthPayload}. */
export function decryptAuthPayload<T = unknown>(
  envelope: AuthEnvelope,
  password: string,
  options: AuthCryptoOptions = {},
): T {
  if (!envelope || envelope.v !== 1 || envelope.alg !== "AES-256-GCM-HKDF-SHA256") {
    throw new AuthError("INVALID_ENVELOPE", "Unsupported authentication envelope");
  }
  const bucketMs = options.bucketMs ?? 50;
  const tolerance = options.toleranceBuckets ?? 4;
  const currentBucket = getTimeBucket(options.nowMs ?? Date.now(), bucketMs);
  if (Math.abs(currentBucket - envelope.bucket) > tolerance) {
    throw new AuthError("ENVELOPE_EXPIRED", "Authentication payload is outside its time bucket window");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveAuthKey(password, envelope.bucket),
      fromBase64Url(envelope.iv),
    );
    decipher.setAuthTag(fromBase64Url(envelope.tag));
    const plaintext = Buffer.concat([
      decipher.update(fromBase64Url(envelope.data)),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("DECRYPT_FAILED", "Could not decrypt authentication payload (wrong password or corrupted data)");
  }
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
