# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `PublicError`: throw it to show a message and code to the client. The
  library's own protocol errors (job expiry, shutdown, timeouts, body limits,
  auth failures) are public too.

### Changed (breaking)

- Errors thrown from routes, actions, and plugins are no longer sent to the
  client with their message. Clients receive `INTERNAL_ERROR` with a generic
  message; the original error goes to `onCallError`, or is logged with
  `console.error` when no error hook is registered. Use `PublicError` for
  errors that clients should see. Errors from client services that a handler
  passes on keep their message, because they came from the caller.
- Callback URLs without `publicBaseUrl` are only built for loopback hosts
  (`localhost`, `127.0.0.1`, `[::1]`). Any other `Host` header now makes
  `callback()` reject with an error that names `publicBaseUrl`. Set
  `publicBaseUrl` for production deployments.
- Action lookup resolves exact normalised names (`mathAdd` for `math.add`)
  and dotted leaf names (`getAvailableSlots` for `delivery.getAvailableSlots`)
  only. Partial names such as `dd` no longer run `math.add`, and an empty
  normalised name is an unknown action.
- External callbacks are recognised by their query and only on paths no
  route serves. `createCallback` rejects a path that a route already serves,
  so a callback URL can never take over a route.
- A resume request must stay on the origin the call started on. The client
  refuses a resume URL on another origin before sending anything.
- A job that expires or is shut down fails with `JOB_EXPIRED` or
  `SERVER_SHUTDOWN` even if its handler returns normally. No new round starts
  after that, so no client service runs for an expired job.
- `use()` rejects a plain object that mixes plugin hooks with service
  functions. Register services with `provide()`.
- A plugin's `onResponse` can change response fields but not the actions the
  client has to execute.

### Fixed

- `server.run` and `server.ask` accept action names that match `Function`
  properties (`name`, `length`, `call`, ...).
- `end()` cleans up even when the client has disconnected, so such jobs no
  longer stay registered.
- Batch results (`require([...])`, `asks()`, `runs()`) are matched to actions
  by `callbackID`, not by arrival order.
- `maxJobs` holds when requests arrive with slow bodies.
- A round that fails before it is sent no longer leaves the job stuck with
  "already has a pending negotiation round".
- Batch named aliases never overwrite `length`, index-like names, or
  `Array.prototype` members.
- Contract checks use own properties, so `constructor` and `toString` are
  rejected unless the contract declares them.
- `provide()` always registers services, and `use()` validates plugin hooks.
- `maxResponseBytes` is enforced while the body streams.
- Abort listeners are removed when each action settles.
- `randomInt` terminates for ranges above 2^31.

## [2.0.0] - 2026-10-16

### Removed (breaking)

- Authentication: `ClientAuthManager`, `ServerAuthManager` (and
  `ServerAuthManagerOptions`), the auth negotiation flow, token registry,
  and the auth example/test. The library no longer ships any auth feature.
- Database persistence: `RequestStore`, `MemoryRequestStore`, and
  `PostgresRequestStore`, the server `store` option, and the optional
  `pg` dependency. Finished calls are no longer saved anywhere; keep your
  own records via `onCallEnd` server plugins if you need them.

### Changed

- The project now keeps only the HTTP negotiation concept:
  `NegotiationClient`/`NegotiationServer`, rounds, asks/runs, external
  callbacks, plugins, and the contract-first API. The web demo no longer
  has an auth panel or users.

## [1.12.0] - 2026-10-16

### Added

- Client plugin halt chain: `onRequest` may return `false`, or call
  `haltRequest()`, to stop a request before fetch with a coded
  `REQUEST_HALTED` error (routed through `onError`, which now also
  observes errors thrown by `onRequest`/`onResponse` hooks).
- Server plugin short-circuit: `onCallStart` may return
  `handledResult(result)` to answer the call itself — remaining start
  hooks and the route handler are skipped.
- `callbackTimeoutMs` server option (defaults to `requestTimeoutMs`).
- 100-scenario end-to-end test suite (`test/scenarios.test.ts`) and
  `example.md` with five client/server examples.

### Changed

- Server plugin hooks renamed to `onCallStart` / `onCallEnd` /
  `onCallError`; `onNegotiation*` and `onJob*` names remain as deprecated
  aliases. Plugin payload types renamed to `ServerPluginCall*` (old
  `ServerPlugin*Job/Result/Error/Round` names kept as type aliases).
- Terminology: `setPreHandler()` (alias `setFallbackHandler`),
  `getActiveCallCount()` (alias `getJobCount()`), `requestService()`
  (deprecated alias `require()`), and docs promote
  `defineService`/`defineAction` over `svc`/`act`.

## [1.11.0] - 2026-10-16

### Added

- Formal server plugin API: `server.plugin(plugin | plugin[])` registers
  `ServerPlugin` lifecycle hooks (`onJobStart`, `onRound`, `onJobEnd`,
  `onJobError`), awaited in registration order for every negotiation job.
  Throwing from `onJobStart`/`onRound` fails the job; throwing from
  `onJobEnd`/`onJobError` is reported through the server's `onError`
  option. Types are exported from `http-negotiation-protocol/server`.

### Fixed

- Stray corrupted token in `NegotiationServer.resolveServerActionName`
  that broke compilation.

## [1.10.0] - 2026-10-13

### Changed

- Renamed `src/auth/client.ts` -> `src/auth/ClientAuthManager.ts` and
  `src/auth/server.ts` -> `src/auth/ServerAuthManager.ts`.

### Added

- `ClientAuthManager` now accepts a `NegotiationClient` as its first
  constructor argument (or via the `client` option) and uses it: after
  `authenticate()` that client automatically sends
  `authorization: Bearer <token>` and `x-auth-uid` on every negotiation
  call, and stops after `close()`.
- `ServerAuthManager` now accepts a `NegotiationServer` as its first
  constructor argument (or via the `server` option) and uses it: its HTTP
  handler serves the auth flow on `authPath` (default `/auth`) and
  delegates all other requests to the NegotiationServer, both share one
  HTTP server via `listen()`/`attach()` wiring, and `close()` shuts both
  down. Standalone (old) constructor forms keep working unchanged.

## [1.9.0] - 2026-10-13

### Added

- Authentication in `src/auth/` (`common.ts`, `client.ts`, `server.ts`,
  exported as `http-negotiation-protocol/auth`): `ServerAuthManager`
  (alias `AuthManager`) and `ClientAuthManager` (alias `ClientAuth`)
  implementing begin -> 50 ms time sync (many fast requests, both sides
  enforce the skew budget) -> uid request (per-user password lookup) ->
  challenge encrypted with AES-256-GCM under HKDF(password, time\50),
  where the challenge is a list of built-in pure function names applied
  to a random input -> encrypted answer -> server-side validation ->
  token saved to the server registry *before* being sent -> ack ->
  handshake closed; a closed/expired session requires a fresh auth
  process. Includes HTTP hosting (`listen`/`attach`/`requestHandler`, a
  transport-agnostic `handleAuthMessage`), `validateToken`/`revokeToken`,
  tests, and `examples/auth.ts`.

## [1.8.0] - 2026-10-13

### Added

- `server.attach(httpServer)` for framework mode: tracks an external HTTP
  server so `server.httpServer` (new read-only getter) is set instead of
  always `undefined`, HTTP `error` events go to `onError`, an external
  `close` event cleans up pending jobs and the store exactly once, and
  `server.close()` closes the attached server. `listen()` now uses the
  same wiring.

### Fixed

- In Express/framework usage, `NegotiationServer.httpServer` was always
  `undefined` and no close/error events were initialised, because
  `listen()` was never called. Negotiation cleanup is now idempotent
  (`shutdownNegotiation()`), so repeated `close()` calls close the store
  only once.

## [1.7.0] - 2026-10-13

### Added

- Framework integration: `server.requestHandler()` (standard Node
  `(req, res)` handler) and `server.handleRequest(req, res)` run the whole
  protocol — routes, resume endpoint, external callbacks — on top of
  Express, Koa, Fastify (raw), or plain `node:http`, without the library
  owning an HTTP server. Bodies pre-parsed by framework body parsers
  (`req.body`) are honoured; `originalUrl` is used for routing when present.
  Includes an Express integration test and `examples/express.ts`.
  (Fetch-style frameworks such as Hono/Next.js still need `server.listen()`.)

## [1.6.0] - 2026-10-13

### Added

- Contract-first typed API: `defineContract({ client, server })` with
  `svc<Result, Data>()` / `act<Result, Data>()` descriptors, plus
  `createServer(contract)` / `createClient(contract)` factories.
  `server.ask.*` and `server.run.*` are now fully typed and autocompleted
  (including dotted paths), and `server.implement(...)` /
  `client.provide(...)` check implementation argument/return types against
  the contract. Out-of-contract names are rejected at runtime.
  The untyped classic/proxy APIs are unchanged.

## [1.5.0] - 2026-10-13

### Added

- `server.runs()` batch builder for server-side actions: chain calls
  (`runs.math.add({...}).delivery.getAvailableSlots({...})`) and execute them
  all in parallel with `await runs.done()`. Results are returned as an array
  in call order, with each result also attached by leaf and full dotted
  action name. Supports per-call `{ fallback }`, nested/bare-leaf/normalised
  action names, and awaiting the builder directly.

## [1.4.0] - 2026-10-13

### Added

- `server.asks()` batch builder: chain client-service calls
  (`asks.selectDeliverySlot({...}).getNames()`) and execute them all in one
  parallel negotiation round with `await asks.done()`. Results are returned
  as an array in call order, with each result also attached by service name.
  Supports per-call `{ fallback }`, dotted service names, and awaiting the
  builder directly.

## [1.3.0] - 2026-10-13

### Added

- Magic proxy syntax: `server.ask.<service>(data)` for client services and
  `server.run.<action>(data)` for server actions (nested dotted names,
  bare-leaf suffix resolution, and normalised names such as `mathAdd`).
  The classic string-based API remains fully backwards-compatible.

## [1.2.0] - 2026-10-13

### Added

- Publishable package entry point (`src/index.ts`, `exports`, `main`, `types`, declaration + source maps).
- GitHub Actions CI (Node 20 & 22: lint, typecheck, test, build) and a release-only npm publish workflow.
- ESLint (flat config), `LICENSE`, `CHANGELOG.md`, and `.nvmrc`.
- Server options `maxJobs`, `jobTimeoutMs`, and a structured `onError` hook.
- Client options `maxRounds`, `maxResponseBytes`, and per-call `signal` / `maxRounds` on `ClientCallRequest`.
- Bounded `MemoryRequestStore` (oldest entries evicted beyond `maxRecords`, default 1000).
- Tests for auth/redaction, invalid resume tokens, unknown routes/jobs, method handling,
  oversized/invalid bodies, unknown client services, round limits, and duplicate external callbacks.
- Demo moved to `examples/demo.ts` so the published build contains only the library.

### Changed

- Resume tokens are rotated on every negotiation round and are single-round.
- Tokens (resume + external callback) are stored only as SHA-256 hashes and
  compared with `timingSafeEqual`.
- Sensitive request headers (`Authorization`, `Cookie`, `x-api-key`, …) are
  redacted as `[REDACTED]` before anything is written to a `RequestStore`.
- `server.close()` now rejects pending rounds/callbacks and force-closes
  keep-alive sockets instead of hanging.
- PostgreSQL store initialisation is shared across concurrent `save()` calls
  and creates a `created_at` index.
- Stricter TypeScript: `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

### Security

- Abandoned jobs now expire (`JOB_EXPIRED`) instead of leaking in memory forever.
- The client can no longer be looped forever by a misbehaving server
  (`MAX_ROUNDS_EXCEEDED`, non-advancing rounds are rejected) and responses
  are size-capped (`RESPONSE_TOO_LARGE`).

## [1.1.0]

- Initial TypeScript implementation: `NegotiationClient`, `NegotiationServer`,
  client services, server actions, external callbacks, in-memory and
  PostgreSQL request stores, and a delivery-estimate demo.
