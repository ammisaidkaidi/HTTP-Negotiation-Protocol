/**
 * Backwards-compatible auth barrel.
 *
 * The implementation is Web Crypto only (`authCrypto.ts`, built on
 * `globalThis.crypto.subtle`) plus the browser-safe shared definitions
 * in `authCore.ts`. There is deliberately no Node-specific-crypto based
 * synchronous variant: Web Crypto operations are asynchronous, so
 * `encryptAuthPayload` / `decryptAuthPayload` return Promises.
 */

export * from "./authCore.js";
export {
  decryptAuthPayload,
  decryptAuthPayloadAsync,
  deriveAuthKeyAsync,
  encryptAuthPayload,
  encryptAuthPayloadAsync,
  generateAuthKey,
} from "./authCrypto.js";
