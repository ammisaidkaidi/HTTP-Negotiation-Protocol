/**
 * Web Crypto implementation of the auth envelope format: AES-256-GCM with
 * the key derived by HKDF-SHA256 from the password, salt
 * `http-negotiation-auth-v1`, info `auth-v1:bucket:<bucket>`, and the
 * 16-byte GCM tag stored separately (Web Crypto returns ciphertext||tag,
 * so encrypt splits the tag off and decrypt appends it again).
 *
 * Both sides derive the same key independently from the shared password
 * and the current universal-time bucket; a generated key
 * (`subtle.generateKey`) could not be reproduced by the other side.
 * Only `globalThis.crypto.subtle` is used — no node:crypto — so this runs
 * unchanged in browsers (secure contexts) and Node.js 20+.
 */
import {
  AuthError,
  DEFAULT_AUTH_TIME_BUCKET_MS,
  getTimeBucket,
  type Clock,
  systemClock,
} from "./authCore.js";
import {
  arrayBuffer,
  base64UrlToBytes,
  bytesToBase64Url,
  randomBytes,
  subtleCrypto,
  type WebCryptoKey,
} from "../src/common/webCrypto.js";

export interface AuthEnvelope {
  v: 1;
  alg: "AES-256-GCM-HKDF-SHA256";
  bucket: number;
  iv: string;
  tag: string;
  data: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Derive the AES-256-GCM key for one time bucket from the password (HKDF-SHA256). */
export async function deriveAuthKey(password: string, bucket: number): Promise<WebCryptoKey> {
  const subtle = subtleCrypto();
  try {
    const baseKey = await subtle.importKey(
      "raw",
      arrayBuffer(textEncoder.encode(password)),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: arrayBuffer(textEncoder.encode("http-negotiation-auth-v1")),
        info: arrayBuffer(textEncoder.encode(`auth-v1:bucket:${bucket}`)),
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new AuthError(
      "WEB_CRYPTO_UNAVAILABLE",
      "Web Crypto (crypto.subtle) is unavailable; use Node.js 20+ or a secure browser context (HTTPS/localhost)",
    );
  }
}

/** Encrypt `payload` as JSON under a key derived from `password + time\20000`. */
export async function encryptAuthPayload(
  payload: unknown,
  password: string,
  options: { clock?: Clock; bucketMs?: number } = {},
): Promise<AuthEnvelope> {
  const bucketMs = options.bucketMs ?? DEFAULT_AUTH_TIME_BUCKET_MS;
  const bucket = getTimeBucket((options.clock ?? systemClock).now(), bucketMs);
  const key = await deriveAuthKey(password, bucket);
  const iv = randomBytes(12);
  const encrypted = new Uint8Array(await subtleCrypto().encrypt(
    { name: "AES-GCM", iv: arrayBuffer(iv) },
    key,
    arrayBuffer(textEncoder.encode(JSON.stringify(payload))),
  ));
  return {
    v: 1,
    alg: "AES-256-GCM-HKDF-SHA256",
    bucket,
    iv: bytesToBase64Url(iv),
    tag: bytesToBase64Url(encrypted.subarray(encrypted.length - 16)),
    data: bytesToBase64Url(encrypted.subarray(0, encrypted.length - 16)),
  };
}

/** Decrypt an envelope produced by {@link encryptAuthPayload}. */
export async function decryptAuthPayload<T = unknown>(
  envelope: AuthEnvelope,
  password: string,
  options: { clock?: Clock; bucketMs?: number; toleranceBuckets?: number } = {},
): Promise<T> {
  if (!envelope || envelope.v !== 1 || envelope.alg !== "AES-256-GCM-HKDF-SHA256") {
    throw new AuthError("INVALID_ENVELOPE", "Unsupported authentication envelope");
  }
  const bucketMs = options.bucketMs ?? DEFAULT_AUTH_TIME_BUCKET_MS;
  const tolerance = options.toleranceBuckets ?? 4;
  const currentBucket = getTimeBucket((options.clock ?? systemClock).now(), bucketMs);
  if (Math.abs(currentBucket - envelope.bucket) > tolerance) {
    throw new AuthError("ENVELOPE_EXPIRED", "Authentication payload is outside its time bucket window");
  }
  try {
    const key = await deriveAuthKey(password, envelope.bucket);
    const data = base64UrlToBytes(envelope.data);
    const tag = base64UrlToBytes(envelope.tag);
    const combined = new Uint8Array(data.length + tag.length);
    combined.set(data);
    combined.set(tag, data.length);
    const plaintext = await subtleCrypto().decrypt(
      { name: "AES-GCM", iv: arrayBuffer(base64UrlToBytes(envelope.iv)) },
      key,
      arrayBuffer(combined),
    );
    return JSON.parse(textDecoder.decode(plaintext)) as T;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("DECRYPT_FAILED", "Could not decrypt authentication payload (wrong password or corrupted data)");
  }
}
