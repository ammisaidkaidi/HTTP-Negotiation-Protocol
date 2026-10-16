# auth-plugin — authentication as plugins

The original challenge-response auth mechanism of this project (previously
`ClientAuthManager`/`ServerAuthManager`, removed from the library in
v2.0.0), rewritten as **plugins** on top of the core protocol. This folder
is a production-oriented pattern/framework — copy it, subclass it, adapt
it. It is not part of the published package.

## Files

| File | Contents |
| --- | --- |
| `authCore.ts` | `AuthError`, time buckets (`time\20000`), challenge functions, payload/session types, `Clock` + `PasswordProvider` abstractions |
| `authCrypto.ts` | AES-256-GCM envelope, HKDF-SHA256 key from password + time bucket (Web Crypto only, browser-safe) |
| `stores.ts` | Abstract `TokenStore` / `SessionStorage` + in-memory defaults |
| `serverAuth.ts` | `ServerAuthPlugin` (guard plugin + login route), `createServerAuth()` |
| `clientAuth.ts` | `ClientAuthPlugin` (token-injection plugin + `auth.*` services), `createClientAuth()` |
| `demo.ts` | Runnable end-to-end demo (`npm run demo:auth-plugin`) |

## Usage

```ts
import { createServerAuth, createClientAuth } from "./auth-plugin/index.js";

// Server: guard plugin + login route (default POST /auth)
const auth = createServerAuth({ getPassword: async (uid) => users[uid] });
auth.register(server);
await auth.validateToken(token); // registry lookup (async: store may be remote)
await auth.revokeToken(token);

// Client: bound to the NegotiationClient at construction (services + the
// token-injection plugin register themselves). Credentials are NOT options —
// they are supplied per login and sourced via getUid()/getPwd().
const clientAuth = createClientAuth({ authUrl, client });
await clientAuth.login({ uid: "user1", pwd: "correct-horse" }); // one logical call
await clientAuth.login({ force: true }); // re-auth with the kept credentials
```

## The flow

1. **Time sync** — server asks `auth.time` over several fast rounds; clocks
   must agree within `maxClockSkewMs` (default 20,000 ms).
2. **Uid** — server asks `auth.getUid`; password looked up by uid.
3. **Challenge** — `{ data, challenge: [f, g, ...], nonce }` encrypted with
   AES-256-GCM under an HKDF key derived from the password and the current
   time bucket; client decrypts, applies the functions, answers encrypted.
4. **Token** — server saves the token in the `TokenStore` first, then sends
   it via `auth.acceptToken`; the client stores the session and acks. The
   guard plugin then accepts `authorization: Bearer <token>` until TTL.
5. **Held request (`auth.protect`)** — routes registered with
   `auth.protect(path, handler)` don't fail unauthenticated calls: the
   server **holds the job at the guard point** and asks the client to log
   in inside that same job (`auth.login` service: the client runs the
   login as a nested call). When the login succeeds, the server verifies
   the issued session in its store (`TokenStore.findByUid`) and executes
   the continuation — your handler — so the original `client.call()`
   receives the result with no error and no retry. If the client cannot
   log in, the held job fails with `AUTH_REQUIRED` like the plain guard.
6. **Automatic re-auth (plain guard routes)** — if a later call fails with the server's
   `AUTH_REQUIRED` error (token expired/revoked), `ClientAuthPlugin`
   captures it, re-runs the login itself with the credentials kept from
   the last `login({ uid, pwd })`, and retries the call once: the caller's
   `client.call()` simply continues. (The retry is a new server job with
   the same request; the original job ended when the error was sent.)
   Disable with `autoLogin: false`.

## Customization (abstract points)

Pass options, implement the abstract stores/providers, or subclass:

- `store: TokenStore` — implement over Redis/Postgres for multi-process or
  durable revocation (methods may return Promises).
- `passwords: PasswordProvider` — database / secret-manager backed lookup
  (or the simple `getPassword(uid)` function).
- `clock: Clock` — synchronized (NTP) or fake clock; both sides.
- `storage: SessionStorage` (client) — sessionStorage/IndexedDB persistence.
- `challengeFunctions` — replace/augment the `f(x) => y` set (identically
  on both sides).
- `tokenGenerator` — your own token format (e.g. prefixed IDs).
- Subclass `ServerAuthPlugin`: `extractToken()`, `isPublicPath()`,
  `onAuthFailed()` (throw vs `handledResult(...)` answers).
- Subclass `ClientAuthPlugin`: `decorateHeaders()` for different header
  schemes (cookies, `x-api-key`, signed headers...).

## Production notes

- Serve over HTTPS; tokens are bearer credentials.
- Default `MemoryTokenStore` is single-process only — plug a shared store
  before scaling out. Consider keying stored tokens by their SHA-256 hash
  so a store leak does not leak usable tokens.
- Keep `tokenTtlMs` short, rotate on re-login (`login(client, { force: true })`),
  and call `revokeToken` on logout where the server must forget immediately.
- The clock check (20,000 ms) assumes NTP-synchronized hosts; widen
  `maxClockSkewMs` only deliberately.
