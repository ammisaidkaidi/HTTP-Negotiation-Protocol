/**
 * Storage abstractions (the "abstract" half of the framework) plus the
 * default in-memory implementations.
 *
 * Production guidance:
 * - Server: implement `TokenStore` over Redis/Postgres when you run more
 *   than one process or need revocation to survive restarts. The interface
 *   is async-friendly: every method may return a Promise.
 * - Client (browser): implement `SessionStorage` over sessionStorage /
 *   IndexedDB if the session must survive a page reload. Never persist
 *   tokens longer than their TTL.
 */
import type { AuthRegistryEntry, AuthSession } from "./authCore.js";

/** Server-side token registry storage (keyed by the plain token). */
export abstract class TokenStore {
  abstract save(entry: AuthRegistryEntry): void | Promise<void>;
  abstract get(token: string): AuthRegistryEntry | undefined | Promise<AuthRegistryEntry | undefined>;
  abstract delete(token: string): boolean | Promise<boolean>;
  /**
   * Latest acknowledged, unexpired entry for a uid (used to verify an
   * in-job login). Default: unsupported (undefined) — override in
   * production stores that can query by uid.
   */
  findByUid(_uid: string): AuthRegistryEntry | undefined | Promise<AuthRegistryEntry | undefined> {
    return undefined;
  }
}

/** Default TokenStore: process memory only (single-process deployments). */
export class MemoryTokenStore extends TokenStore {
  private readonly entries = new Map<string, AuthRegistryEntry>();

  save(entry: AuthRegistryEntry): void {
    this.entries.set(entry.token, entry);
  }

  get(token: string): AuthRegistryEntry | undefined {
    return this.entries.get(token);
  }

  delete(token: string): boolean {
    return this.entries.delete(token);
  }

  findByUid(uid: string): AuthRegistryEntry | undefined {
    let latest: AuthRegistryEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.uid === uid && entry.acknowledged && (!latest || entry.issuedAt > latest.issuedAt)) {
        latest = entry;
      }
    }
    return latest;
  }

  /** Number of stored (not necessarily unexpired) tokens — diagnostics. */
  get size(): number {
    return this.entries.size;
  }
}

/** Client-side session storage (a single current session). */
export abstract class SessionStorage {
  abstract read(): AuthSession | undefined;
  abstract write(session: AuthSession): void;
  abstract clear(): void;
}

/** Default SessionStorage: memory only; the session dies with the page/process. */
export class MemorySessionStorage extends SessionStorage {
  private session: AuthSession | undefined;

  read(): AuthSession | undefined {
    return this.session;
  }

  write(session: AuthSession): void {
    this.session = session;
  }

  clear(): void {
    this.session = undefined;
  }
}
