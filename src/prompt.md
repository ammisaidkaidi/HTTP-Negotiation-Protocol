# HTTP Negotiation Protocol — Full Prompt, Plan, and Workflow

This file is the complete project brief for the **HTTP Negotiation Protocol**
TypeScript library. It can be used as:

1. a master prompt for an AI coding agent,
2. an implementation plan for a human developer,
3. a workflow/reference document for the current architecture.

---

## 1. Master prompt

```text
Build and maintain a TypeScript library called "HTTP Negotiation Protocol".

The library implements a request-negotiation protocol over HTTP:

- A client starts one logical request with NegotiationClient.call().
- A NegotiationServer route handler runs as a long-lived job.
- While the job runs, the server can ask the client to execute named client
  services, run server-side actions, batch several asks/actions, and wait for
  external callbacks.
- The HTTP conversation proceeds in rounds. The first response either finishes
  the job or returns actions plus a jobId, a round number, a one-round resume
  token, and a resume URL. The client executes the requested services, posts
  the results to /__negotiation/resume, and the server continues. The last
  response finishes the job with the final result or an error.

Implement the library in TypeScript as an ESM package for Node.js >= 20.

Required public API:

Server:
- class NegotiationServer with:
  - handle(path, handler)
  - use(actions) to register server actions
  - implement(actions) for contract-checked server actions
  - ask.<service>(data) magic proxy for one client service
  - asks() batch builder: chained calls, then done(), all in one round
  - run.<action>(data) magic proxy for one server action
  - runs() batch builder: chained calls, then done(), executed in parallel
  - require(name, data), require(actions), require({ actions }),
    requireMany(actions)
  - call(name, data) for server actions
  - callback(actionName, data, callbackPathOrUrl?) for external callbacks
  - createCallback(request, server.call(...), callbackOrUrl?)
  - respond(request, result), end(result?)
  - requestHandler() returning a Node (req, res) handler
  - handleRequest(req, res)
  - attach(httpServer) to attach an application-owned HTTP server
  - httpServer getter
  - close() that closes the attached HTTP server if present, rejects pending
    jobs, and closes the store exactly once
  - getActiveCallCount()
- createServer(contract, options?) for contract-first servers.
- MemoryRequestStore and PostgresRequestStore request stores.

Important hosting decision:
- NegotiationServer must NOT have a listen() method.
- The application owns the HTTP server:
    const httpServer = createHttpServer(server.requestHandler());
    server.attach(httpServer);
    httpServer.listen(port, host);
- server.close() must also close an attached HTTP server.

Client:
- class NegotiationClient with:
  - use(plugin | plugins | services)
  - provide(services) for contract-checked client services
  - call({ url, params, data, headers, signal, maxRounds })
- createClient(contract, options?)
- Client plugins with onRequest/onResponse/onError.
- Client services are allow-listed by registration only.

Contract-first API:
- defineContract({ client, server })
- svc<Result, Data>() declares a client service.
- act<Result, Data>() declares a server action.
- createServer(contract) and createClient(contract) derive typed ask/run
  proxies and checked implement()/provide() registration.
- Registering or asking for names outside the contract must fail.
- The untyped classic API remains available.

Syntax requirements:
- One client service:
    await server.ask.getName(data)
- Nested client service:
    await server.ask.location.getArea(data)
- Several client services in ONE negotiation round:
    const asks = server.asks();
    asks.getCurrentLocation({}, { fallback: null })
        .getDeliveryPreferences({});
    const results = await asks.done();
  Results are an array in call order and also accessible by leaf name and by
  full dotted name. Builders are single-use and are also awaitable.
- One server action:
    await server.run.math.add({ a: 2, b: 3 })
  Bare leaf names and normalised names resolve to a unique registered action;
  ambiguous names throw.
- Several server actions in parallel:
    const runs = server.runs();
    runs.math.add({ a: 2, b: 3 }).delivery.getAvailableSlots({ period: "am" });
    const results = await runs.done();

Protocol and safety requirements:
- Rotate the resume token every round; a token resumes exactly one round once.
- Store only SHA-256 hashes of resume/callback tokens.
- Match results by callbackID and reject missing/duplicate/unexpected IDs.
- Per-round timeout, whole-job timeout, maximum jobs, body-size limits,
  response-size limits, client service timeouts, request timeouts.
- Redact sensitive headers before persisting requests to a store.
- External callbacks use generated jobId/callbackID/token callback URLs;
  duplicate callbacks are acknowledged without settling twice.
- Structured onError hooks; error hooks must never break the protocol flow.

Authentication (auth negotiation):
- Authentication is itself a negotiation, not a separate POST state machine.
- ClientAuthManager is constructed with a NegotiationClient:
    const clientAuth = new ClientAuthManager(negotiationClient, {
      authUrl: "http://127.0.0.1:4000/auth",
      uid: "user1",
      password: "correct-horse",
      timeBucketMs: 20_000,
    });
    const session = await clientAuth.authenticate();
- ServerAuthManager is constructed with a NegotiationServer:
    const authServer = new ServerAuthManager(negotiationServer, {
      getPassword: async (uid) => users[uid],
    });
  It registers the /auth route on that server in its constructor.
- ServerAuthManager never creates an HTTP server. Hosting pattern:
    const http = createHttpServer(authServer.requestHandler());
    authServer.attach(http);
    await authServer.listen(4000); // starts the attached HTTP server
  authServer.listen() must reject when there is no bound server or no attached
  HTTP server.
- One authenticate() call is one logical NegotiationClient.call() to /auth.
  Inside it the server asks for client services:
    auth.time, auth.getUid, auth.solveChallenge, auth.acceptToken.
- Time synchronisation: several fast auth.time rounds; the fastest sample gives
  the offset; client/server clocks must agree within 20,000 ms by default or
  the job fails with CLOCK_SKEW.
- The encryption time bucket is also 20,000 ms by default (time\20000).
- Times are universal: use UTC epoch milliseconds (utcNow()). ServerAuthManager
  exposes startedAtUtc (reset on listen()/attach()) and universalTime as ISO
  8601 UTC strings.
- Challenge flow:
    1. server asks auth.getUid
    2. server resolves the password through getPassword(uid)
    3. server creates { data, challenge, nonce }, where challenge is a list of
       built-in pure function names f(x) => y
    4. server encrypts it and asks auth.solveChallenge
    5. client decrypts, applies the functions in order, returns
       { result, nonce } encrypted the same way
    6. server decrypts and validates nonce/result
    7. on success the server generates a token, FIRST saves it to its registry,
       THEN sends it through auth.acceptToken
    8. the client stores the token and returns { ack: true }
    9. the server marks the registry entry acknowledged and ends the job
- After authenticate(), the bound NegotiationClient automatically sends
  "authorization: Bearer <token>" and "x-auth-uid". After clientAuth.close()
  it stops, and the next authenticate() runs a fresh negotiation and creates
  a new token.
- ServerAuthManager exposes registry, validateToken(token), revokeToken(token).

Crypto requirements:
- Do NOT import Node's crypto module anywhere in src/.
- Use only Web Crypto: globalThis.crypto.subtle plus
  crypto.getRandomValues / crypto.randomUUID.
- Auth envelopes: AES-256-GCM; key = HKDF-SHA256(password, salt
  "http-negotiation-auth-v1", info "auth-v1:bucket:<bucket>").
  Use crypto.subtle.importKey + deriveKey for the shared password-derived key,
  because both sides must derive the same key independently. Use
  crypto.subtle.generateKey for fresh random AES-GCM keys (generateAuthKey)
  and for generating session tokens (export the raw generated key and
  base64url-encode it).
- SHA-256 token hashing uses crypto.subtle.digest.
- encryptAuthPayload/decryptAuthPayload are asynchronous (Web Crypto is
  async); there is no synchronous variant.
- Random integers/UUIDs come from Web Crypto helpers in src/common/webCrypto.ts.

Browser demo (demo/):
- demo/server.ts runs one Node HTTP server that serves the page, /api/state,
  /browser-lib/*, /auth, and the negotiation routes.
- At startup the demo server resets its process time zone to UTC+0 and logs
  the universal startup time.
- The page imports the real client library from /browser-lib/client/index.js
  (demo server transpiles src/client and src/common TypeScript on demand).
- The Authenticate button must run ClientAuthManager with the browser
  NegotiationClient directly. There must be no /api/auth fetch endpoint.
- The same browser NegotiationClient is used for /whoami and
  /delivery/estimate, so the Bearer token is carried automatically.
- The demo page shows an "Auth workflow" panel with every auth operation as
  a live step: browser client creation, manager binding, begin, auth.time
  samples, auth.getUid, encrypted challenge creation, auth.solveChallenge,
  answer validation, token generation, registry save, auth.acceptToken/ack,
  acknowledged job end, and later token use/close. Steps move
  pending -> active -> done/failed, driven by the real auth.* asks the page
  observes and by the server registry in /api/state.

Build requirements:
- Root tsconfig.json: strict whole-project typecheck (no emit).
- tsconfig.build.json: full package build to dist/ (used by npm run build).
- src/tsconfig-client.json and src/tsconfig-server.json define the client and
  server project boundaries (bundler module resolution, noEmit typecheck).
- Single-file bundles:
    npm run build:client  -> dist/client.js  (browser platform, ESM)
    npm run build:server  -> dist/server.js  (Node platform, ESM)
    npm run build:bundles -> both
  Bundling uses esbuild with the matching src/tsconfig-*.json.
- dist/ must be generated beside src/, test/, and examples/ at the repo root
  (the src configs resolve ../dist). Note: this workspace's file browser may
  hide generated dist/ folders; dist.zip can be produced for download.
- package.json exports keep pointing at the full build outputs
  (dist/index.js, dist/client/index.js, dist/server/index.js).

Repository rules:
- Library TypeScript sources live in src/ (client/, server/, common/).
- Tests live in test/, examples in examples/, the web demo in demo/.
- Push only to the main branch of
  https://github.com/ammisaidkaidi/HTTP-Negotiation-Protocol when asked.
- Do not commit or push unless the user explicitly asks.
- Never print, store, or commit credentials/tokens supplied in chat.

Verification for every change:
- npm ci --no-audit --no-fund (when node_modules is missing)
- npm run typecheck
- npm run lint
- npm test
- npm run build
- Run the affected examples/demo and smoke-test real HTTP flows.
```

---

## 2. Product definition

### 2.1 What the library is

A minimal TypeScript protocol for **negotiated HTTP requests**: one logical
client request can involve several HTTP rounds in which the server asks the
client for data/services, runs its own actions, and waits for third-party
callbacks — while application code reads as ordinary sequential `async/await`.

### 2.2 What it is not

- Not a general HTTP framework (no router beyond negotiation routes, no
  middleware pipeline).
- Not a multi-process/distributed job system: active jobs live in memory in
  one process and are not recovered after restart.
- Not a fetch-style (`Request`/`Response`) framework adapter: Hono/Next-style
  hosting needs an adapter that is not implemented yet.
- Not an auth server product: the auth managers implement one
  challenge–response negotiation flow; user storage, password policy, MFA,
  refresh tokens, and token gating middleware are application concerns.

### 2.3 Design principles

- **One logical call** hides rounds, resume tokens, and callback IDs.
- **Sequential-looking code** for multi-round interactions (`ask`, `asks`,
  `run`, `runs`, `callback`).
- **Contract-first when wanted**: shared contract, typed proxies, checked
  registration; untyped API stays available.
- **The application owns HTTP**: servers are hosted via
  `requestHandler()`/`attach()`; nothing calls `listen()` for you.
- **Browser-safe client**: the client and auth client run in browsers using
  Web Crypto; no Node-specific crypto imports anywhere.
- **Universal time**: auth compares UTC epoch milliseconds; displayed server
  times are ISO UTC.
- **Fail closed**: unknown services, bad resume tokens, wrong rounds,
  tampered challenges, and unacknowledged tokens all fail the job.

---

## 3. Repository layout

```text
HTTP-Negotiation-Protocol/
├── src/
│   ├── prompt.md                   # this document
│   ├── tsconfig-client.json        # client project (bundler, noEmit)
│   ├── tsconfig-server.json        # server project (bundler, noEmit)
│   ├── client/
│   │   ├── index.ts
│   │   ├── NegotiationClient.ts    # call(), plugins, client services
│   │   └── ClientAuthManager.ts    # auth.* services + authenticate()
│   ├── server/
│   │   ├── index.ts
│   │   ├── NegotiationServer.ts    # jobs, rounds, routes, callbacks
│   │   └── ServerAuthManager.ts    # /auth negotiation route + registry
│   └── common/
│       ├── negotiations.ts         # wire types, contracts, shared helpers
│       ├── authCore.ts             # auth errors, time buckets, challenges
│       ├── authCrypto.ts           # Web Crypto AES-GCM/HKDF envelopes
│       ├── auth.ts                 # backwards-compatible auth barrel
│       └── webCrypto.ts            # subtle/digest/random helpers (no node:crypto)
├── test/
│   └── auth.test.ts
├── examples/
│   ├── demo.ts                     # delivery-estimate negotiation demo
│   ├── express.ts                  # Express/requestHandler/attach demo
│   └── auth.ts                     # bound auth managers demo
├── demo/
│   ├── server.ts                   # web demo server (page + library hosting)
│   ├── index.html                  # web demo UI + live auth workflow panel
│   └── README.md
├── tsconfig.json                   # strict whole-project typecheck (noEmit)
├── tsconfig.build.json             # full package build to dist/
├── package.json
└── dist/                           # generated; beside src/, test/, examples/
```

---

## 4. Core protocol workflow

### 4.1 One logical request, many rounds

```text
Client (NegotiationClient.call)            Server (NegotiationServer job)
---------------------------------          --------------------------------
POST /route { params, data }
                                           create job (jobId, round 0)
                                           run route handler
                                           handler: await server.ask.foo(data)
POST /__negotiation/resume  <-----------   200 { protocol:1, done:false,
{ jobId, round, resumeToken, results }       round:1, actions:[foo],
                                             resumeUrl, resumeToken }
execute service "foo"
POST /__negotiation/resume --------------> match jobId + token hash + round
                                           resolve pending ask, continue
                                           handler returns final value
200 { done:true, result } <--------------  end job, persist final pair, cleanup
```

### 4.2 Round rules

- Each round rotates the resume token; only the hash is stored.
- The client must return exactly the expected `callbackID`s, once each.
- A response with `done:false` must have a strictly increasing round.
- The client enforces `maxRounds`; the server enforces per-round and
  whole-job timeouts.
- If the handler throws, the job ends with `done:true` and an error payload;
  the client rethrows it as an `Error` with a `code`.

### 4.3 Batch builders

- `server.asks()` collects client-service calls and executes them in **one**
  round via `requireMany`; per-call `fallback` is supported; results keep
  call order and are also keyed by leaf/full service names.
- `server.runs()` collects server actions and executes them in parallel
  locally (no network round), with the same result-keying rules.
- Both builders are single-use and awaitable (`await asks` ≡ `await asks.done()`).

### 4.4 External callbacks

```text
handler: await server.callback("carrier.requestQuote", data)
  -> creates callbackID + token, builds callbackUrl (?jobId&callbackID&token)
  -> the named server action receives { ...data, callbackUrl } and arranges
     the third-party call
  -> provider POSTs the callbackUrl with the result body
  -> server verifies jobId/callbackID/token hash, settles the wait once
     (duplicates get { ok:true, duplicate:true })
  -> handler continues with the callback payload
```

### 4.5 Hosting workflow (no `server.listen()`)

```ts
import { createServer as createHttpServer } from "node:http";

const httpServer = createHttpServer(server.requestHandler());
server.attach(httpServer);            // tracks httpServer, wires error/close
await new Promise<void>((resolve) => httpServer.listen(3000, "127.0.0.1", resolve));
// shutdown:
await server.close();                  // closes attached HTTP, jobs, and store
```

Framework mode (Express/Koa/Fastify-raw/plain `node:http`): mount
`server.requestHandler()` at the root; pre-parsed `req.body` and
`req.originalUrl` are honoured. Without `attach()`, `close()` only cleans up
jobs/store and never touches the application's HTTP server.

---

## 5. Authentication workflow

### 5.1 Participants

- **ClientAuthManager** (`clientAuth`): bound to a `NegotiationClient`;
  registers `auth.time`, `auth.getUid`, `auth.solveChallenge`,
  `auth.acceptToken` services plus a token-injecting plugin. The services
  answer only while an auth negotiation is in progress.
- **ServerAuthManager** (`authManager`): bound to a `NegotiationServer`;
  registers the `/auth` route; owns the per-user password lookup and the
  token registry.

### 5.2 Step-by-step flow

```text
clientAuth <--> authManager                              (one negotiation job)
 1. begin          client -> negotiationClient.call(authUrl, { begin:true })
 2. time sync      server -> ask auth.time  (xN fast rounds, fastest sample)
                   client -> UTC epoch ms
                   require |clientOffset| <= 20,000 ms, else CLOCK_SKEW + close
 3. uid            server -> ask auth.getUid
                   client -> uid
                   server -> password = getPassword(uid)   (UNKNOWN_UID if none)
 4. challenge      server builds { data, challenge:[fn...], nonce }
                   encrypts AES-256-GCM, key = HKDF-SHA256(password,
                   bucket = floor(utcNow / 20,000))
                   server -> ask auth.solveChallenge(envelope)
 5. solve          client decrypts, applies f(x)=>y functions in order,
                   returns { result, nonce } encrypted the same way
 6. validate       server decrypts; nonce + result must match
                   (DECRYPT_FAILED / CHALLENGE_FAILED otherwise)
 7. success        server generates token (crypto.subtle.generateKey raw bytes)
                   server FIRST: registry.set(token, { uid, ..., acknowledged:false })
                   server -> ask auth.acceptToken({ token, uid, expiresAt })
 8. ack            client stores the session, returns { ack:true }
                   (if ack fails, the server deletes the just-saved token)
 9. end            server marks entry acknowledged:true (+acknowledgedAt),
                   returns { authenticated, uid, expiresAt, clockOffsetMs },
                   job ends (connection closed)
10. afterwards     bound client sends authorization: Bearer <token> (+x-auth-uid)
                   clientAuth.close() forgets the token; a fresh authenticate()
                   runs the whole flow again and produces a new token
```

### 5.3 Timing and crypto parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `maxClockSkewMs` | 20,000 | accepted client/server clock difference |
| `timeBucketMs` | 20,000 | encryption bucket width (`time\20000`) |
| `timeSamples` | 5 | fast `auth.time` rounds |
| `challengeLength` | 3 | built-in functions per challenge |
| `tokenTtlMs` | 900,000 | registry token lifetime (15 min) |
| decrypt tolerance | ±4 buckets | neighbouring-bucket edge races |

- Built-in challenge functions: `add1`, `add7`, `subtract3`, `double`,
  `triple`, `multiply5`, `square`, `negate`, `xor42`, `plus100`
  (pure deterministic integer functions, identical on both sides).
- Envelope: `{ v:1, alg:"AES-256-GCM-HKDF-SHA256", bucket, iv, tag, data }`
  (base64url parts; Web Crypto's ciphertext||tag is split for storage).
- Passwords are password-equivalents: source them from a secret manager/DB,
  and run auth over HTTPS in production.
- The 20-second window is a usability/security trade-off chosen for this
  project; tighten `maxClockSkewMs`/`timeBucketMs` for stricter deployments
  with NTP-synced hosts.

### 5.4 Server startup/time behaviour

- Managers use `utcNow()` (UTC epoch ms) for all comparisons.
- `ServerAuthManager.startedAtUtc` records the startup instant (ISO UTC) and
  is reset by `listen()`/`attach()`; `universalTime` returns the current ISO
  UTC time.
- The demo server additionally sets `process.env.TZ = "UTC"` at startup and
  displays server UTC in the page header. (A process cannot change the OS
  clock; UTC epoch comparisons are timezone-independent by construction.)

---

## 6. Browser demo workflow

```text
Browser page (demo/index.html)                 Demo server (demo/server.ts)
--------------------------------------         ---------------------------------
GET /                        ----------------> serves index.html
import /browser-lib/client/index.js --------> transpiles src/client + src/common
creates NegotiationClient + delivery services
click Authenticate:
  new ClientAuthManager(negotiationClient)
  clientAuth.authenticate() -- /auth -------> ServerAuthManager auth negotiation
  (workflow panel lights each step from the
   observed auth.* asks + /api/state)
click Call /whoami: negotiationClient.call -> /whoami route (Bearer attached)
click Run /delivery/estimate: one call -----> asks() + run.* + ask.* + callback()
GET /api/state (poll) ----------------------> registry, active jobs, server UTC,
                                              server log (read-only status only)
```

Rules demonstrated by the demo:

- No `/api/auth` endpoint exists; authentication is the browser library
  talking to `/auth` directly.
- `/api/state` contains no auth/negotiation logic.
- The workflow panel (13 steps) is driven by the real protocol responses
  (`body.actions[*].name`) plus the registry from `/api/state`, and marks the
  failing step red for `CLOCK_SKEW`, `UNKNOWN_UID`, challenge, or ack errors.
- Web Crypto requires a secure context: use HTTPS or localhost.

Demo server actions in the estimate flow: the server asks the browser for
`getCurrentLocation` (denied in the demo, so the `asks()` fallback is used)
and `getDeliveryPreferences` in one round, runs
`delivery.getAvailableSlots` as a server action, asks `selectDeliverySlot`,
then waits for the simulated carrier callback (`carrier.requestQuote`)
before returning the final estimate.

---

## 7. Implementation plan

### Phase 0 — Foundations (done)
- [x] TypeScript ESM package, strict config, ESLint, Node >= 20.
- [x] Core protocol: jobs, rounds, resume tokens, stores, timeouts.
- [x] Client services, server actions, external callbacks.

### Phase 1 — Syntax layers (done)
- [x] Magic proxies `server.ask.*` / `server.run.*` (v1.3).
- [x] `server.asks()` one-round batch builder (v1.4).
- [x] `server.runs()` parallel action builder (v1.5).
- [x] Contract-first typed API: `defineContract`, `svc`, `act`,
      `createServer`, `createClient`, checked `implement`/`provide` (v1.6).

### Phase 2 — Hosting (done)
- [x] `server.requestHandler()` / `handleRequest()` framework integration,
      pre-parsed bodies, `originalUrl` (v1.7).
- [x] `server.attach(http)` lifecycle wiring, `httpServer`, idempotent
      exactly-once shutdown (v1.8).
- [x] Removed `NegotiationServer.listen()`: the application owns HTTP;
      examples, tests, README migrated to `requestHandler()` + `attach()`.

### Phase 3 — Code organisation (done)
- [x] Split into `src/client/`, `src/server/`, `src/common/` with folder
      barrels `src/client/index.ts`, `src/server/index.ts`; root
      `src/index.ts` is the public barrel.
- [x] Tests moved to root `test/`; web demo in root `demo/`.

### Phase 4 — Authentication (done)
- [x] Auth as a negotiation between `ClientAuthManager` and
      `ServerAuthManager` over `auth.*` services (v1.9).
- [x] Manager binding: client manager drives the bound `NegotiationClient`
      and injects the Bearer token; server manager registers `/auth` on the
      bound `NegotiationServer` and delegates hosting to it (v1.10).
- [x] Timing widened from 50 ms to 20,000 ms (skew + bucket) with UTC clocks.
- [x] Web Crypto only: removed every Node crypto import; HKDF/AES-GCM via
      `crypto.subtle`, tokens via `crypto.subtle.generateKey`, SHA-256 via
      `crypto.subtle.digest`.

### Phase 5 — Browser demo (done)
- [x] Web demo with in-browser `NegotiationClient` + `ClientAuthManager`.
- [x] Live 13-step auth workflow panel.
- [x] Server UTC startup display (`/api/state`: `serverTimeUtc`,
      `serverStartedAtUtc`).

### Phase 6 — Build outputs (done)
- [x] Full package build (`tsconfig.build.json`) to `dist/`.
- [x] `src/tsconfig-client.json` / `src/tsconfig-server.json` project splits.
- [x] Single-file bundles with esbuild:
      `dist/client.js` (browser) and `dist/server.js` (Node).

### Phase 7 — Possible future work (not implemented)
- [ ] Fetch-style adapter for Hono/Next (`Request`/`Response`).
- [ ] Token-gating helper/middleware for negotiation routes.
- [ ] Multi-process job coordination / resumable jobs after restart.
- [ ] Single-file `.d.ts` bundling for the esbuild bundles.
- [ ] Version bump + CHANGELOG entry for the post-1.10 changes, then commit
      and push to `main` when the user asks.

---

## 8. Development workflow

### 8.1 Setup

```bash
npm ci --no-audit --no-fund     # node_modules is not persisted between sessions
```

### 8.2 Edit–verify loop

```bash
npm run typecheck               # strict TS, whole project
npm run lint                    # ESLint flat config
npm test                        # tsx --test test/*.test.ts
npm run build                   # full package build to dist/
npm run build:bundles           # dist/client.js + dist/server.js (esbuild)
```

### 8.3 Run the demos

```bash
npm run demo                    # examples/demo.ts (delivery estimate)
npm run demo:express            # examples/express.ts (framework hosting)
npm run demo:auth               # examples/auth.ts (bound auth managers)
PORT=3000 npm run demo:web      # demo/ web UI on http://127.0.0.1:3000
```

Web demo usage: **Authenticate** (`user1` / `correct-horse`) → watch the
workflow panel → **Call /whoami** → **Run /delivery/estimate** → try a wrong
password, an unknown uid, or a clock outside the 20,000 ms window to see the
failing step.

### 8.4 Before finishing any change

- [ ] Typecheck, lint, tests pass.
- [ ] Affected examples/demo smoke-tested over real HTTP.
- [ ] No Node crypto import reintroduced (`grep -R "node:crypto" src` is empty).
- [ ] README/demo docs updated when behaviour or syntax changes.
- [ ] Generated artifacts (`dist/`, `node_modules/`, `dist.zip`) not committed.
- [ ] Commit/push only when the user explicitly asks (branch: `main`).

---

## 9. Acceptance criteria

### Protocol
- [ ] A route using `ask`, `asks().done()`, `run`, `runs().done()`, and
      `callback()` completes in one `client.call()` and returns the result.
- [ ] Bad resume token → 403 `INVALID_RESUME_TOKEN`; wrong round → 409;
      missing/duplicate callback IDs → 400; unknown job → 404.
- [ ] Duplicate external callback does not settle the wait twice.
- [ ] `server.close()` rejects pending jobs, closes the store once, and
      closes an attached HTTP server.

### Auth
- [ ] Full flow succeeds for a known uid/password; registry entry exists
      before the token is delivered and is `acknowledged` afterwards.
- [ ] Unknown uid → `UNKNOWN_UID`; wrong password →
      `DECRYPT_FAILED`/`CHALLENGE_FAILED`; clock difference > 20,000 ms →
      `CLOCK_SKEW`; tampered challenge answer is rejected.
- [ ] A clock difference inside 20,000 ms succeeds.
- [ ] After `clientAuth.close()`, calls carry no token and re-authentication
      produces a different token.
- [ ] Web Crypto envelopes round-trip and reject wrong passwords;
      `generateAuthKey` returns a generated AES-GCM key object.

### Demo/build
- [ ] The Authenticate button runs `ClientAuthManager` + browser
      `NegotiationClient` (no `/api/auth` fetch), and the workflow panel
      marks each step from the observed `auth.*` asks.
- [ ] `/api/state` reports server UTC times and the registry.
- [ ] `npm run build:bundles` emits exactly `dist/client.js` and
      `dist/server.js`, and both bundles import and complete an auth flow.
- [ ] `NegotiationServer` has no `listen` property at runtime.

---

## 10. Security notes

- Run production auth over **HTTPS**; Web Crypto (`crypto.subtle`) also
  requires a secure context in browsers (HTTPS or localhost).
- Passwords are password-equivalents (they derive the challenge keys):
  store them in a secret manager/DB, never in source control.
- The 20,000 ms window and ±4-bucket decrypt tolerance are deliberately
  permissive for this project; stricter deployments should lower them and
  keep hosts NTP-synced.
- Resume/callback tokens are random, single-purpose, rotated per round, and
  only their SHA-256 hashes are stored/compared.
- Sensitive headers are redacted before requests are persisted to a store.
- The library does not yet gate routes on auth tokens: applications should
  check `authServer.validateToken(token)` in their routes/middleware.

---

## 11. Current status (for context)

- Package version: `1.10.0`; remote `main` is at the module-rename commit,
  and the folder restructure, auth-negotiation rewrite, UTC/20-second
  timing, Web-Crypto-only crypto, `listen()` removal, browser demo with the
  live workflow panel, `src/tsconfig-*.json` splits, and single-file esbuild
  bundles are implemented and verified locally (typecheck, lint, tests 8/8,
  full build, bundle build, examples, and live demo smoke tests).
- These post-1.10 changes are intentionally **uncommitted** until the user
  asks to commit/push.
