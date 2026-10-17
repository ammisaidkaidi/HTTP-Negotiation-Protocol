/**
 * Small Web Crypto helpers shared by the client, server, and auth code.
 *
 * This module intentionally uses only `globalThis.crypto` — the Web
 * Crypto API available in browsers and Node.js 20+ — and never imports
 * Node's crypto module. The small structural types below describe just the
 * subset of Web Crypto used here, so the file type-checks without DOM
 * lib types and transpiles to import-free browser JavaScript.
 */

export type WebCryptoKey = object;

type WebCryptoAlgorithm = string | Record<string, unknown>;

interface SubtleCryptoLike {
  digest(algorithm: WebCryptoAlgorithm, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: ArrayBuffer,
    algorithm: WebCryptoAlgorithm,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<WebCryptoKey>;
  deriveKey(
    algorithm: WebCryptoAlgorithm,
    baseKey: WebCryptoKey,
    derivedKeyType: WebCryptoAlgorithm,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<WebCryptoKey>;
  encrypt(
    algorithm: WebCryptoAlgorithm,
    key: WebCryptoKey,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: WebCryptoAlgorithm,
    key: WebCryptoKey,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer>;
  generateKey(
    algorithm: WebCryptoAlgorithm,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<WebCryptoKey>;
  exportKey(format: string, key: WebCryptoKey): Promise<ArrayBuffer>;
}

interface WebCryptoLike {
  subtle: SubtleCryptoLike;
  getRandomValues<T extends Uint8Array>(array: T): T;
  randomUUID?: () => string;
}

function webCrypto(): WebCryptoLike {
  const crypto = (globalThis as unknown as { crypto?: WebCryptoLike }).crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== "function") {
    throw new Error(
      "Web Crypto (globalThis.crypto.subtle) is unavailable; use Node.js 20+ or a secure browser context (HTTPS/localhost)",
    );
  }
  return crypto;
}

/** The shared `crypto.subtle` object (browser Web Crypto / Node WebCrypto). */
export function subtleCrypto(): SubtleCryptoLike {
  return webCrypto().subtle;
}

/** Copy bytes into a standalone ArrayBuffer for Web Crypto calls. */
export function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Cryptographically secure random bytes from `crypto.getRandomValues`. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new TypeError("randomBytes length must be a non-negative integer");
  }
  const bytes = new Uint8Array(length);
  const crypto = webCrypto();
  // getRandomValues accepts at most 65,536 bytes per call.
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65_536)));
  }
  return bytes;
}

/** UUID from `crypto.randomUUID()`, with a getRandomValues fallback. */
export function randomUuid(): string {
  const crypto = webCrypto();
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Cryptographically secure integer in `[min, maxExclusive)`. */
export function randomInt(min: number, maxExclusive: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(maxExclusive) || maxExclusive <= min) {
    throw new TypeError("randomInt requires integer bounds with maxExclusive > min");
  }
  const range = maxExclusive - min;
  if (!Number.isSafeInteger(range)) throw new TypeError("randomInt range is too large");
  // BigInt keeps the arithmetic exact for every safe-integer range. (32-bit
  // bitwise operators overflow above 2^31, which used to make this loop forever.)
  const span = BigInt(range);
  const byteLength = Math.max(1, Math.ceil((span - 1n).toString(2).length / 8));
  const space = 1n << BigInt(byteLength * 8);
  // Rejection sampling: discard draws in the uneven tail to avoid modulo bias.
  const limit = space - (space % span);
  while (true) {
    const bytes = randomBytes(byteLength);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value < limit) return min + Number(value % span);
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** SHA-256 hex digest via `crypto.subtle.digest`. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await subtleCrypto().digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

/** Length-aware constant-time string comparison (no Node timingSafeEqual). */
export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** Generate a fresh AES-256-GCM key with `crypto.subtle.generateKey`. */
export async function generateAesGcmKey(extractable = false): Promise<WebCryptoKey> {
  return subtleCrypto().generateKey(
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
}

/**
 * Generate a random 32-byte token. The randomness comes from a fresh
 * AES-256-GCM key created by `crypto.subtle.generateKey` and exported
 * in raw form, then base64url-encoded.
 */
export async function generateRandomToken(): Promise<string> {
  const key = await generateAesGcmKey(true);
  const raw = await subtleCrypto().exportKey("raw", key);
  return bytesToBase64Url(new Uint8Array(raw));
}
