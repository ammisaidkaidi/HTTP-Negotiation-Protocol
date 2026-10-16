/**
 * Auth plugin framework for the HTTP Negotiation Protocol.
 *
 * Auth as plugins — the original challenge-response mechanism (time sync,
 * encrypted challenge, token registry) reshaped onto the plugin system:
 *
 *   import { createServerAuth, createClientAuth } from "./auth-plugin/index.js";
 *
 * Not part of the published library (v2.0.0 is core-only); this folder is a
 * production-oriented pattern you can copy, subclass, and customize.
 */
export * from "./authCore.js";
export * from "./authCrypto.js";
export * from "./stores.js";
export * from "./serverAuth.js";
export * from "./clientAuth.js";
