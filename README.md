# HTTP Negotiation Protocol

A small TypeScript library for one logical `Client.call()` that can span multiple HTTP requests while the server asks the client to execute registered services.

The public API hides `jobId`, `callbackID`, resume tokens, and the negotiation loop.

## Requirements

- Node.js 20 or newer
- npm
- Optional PostgreSQL database for durable request/response logs (`pg` is an optional dependency)

## Run

```bash
npm install
npm run build
npm start
```

The demo starts a local HTTP server, runs a complete delivery-estimate flow, prints the final result, and stops. The client and server are separate objects in one process but communicate over real HTTP on `127.0.0.1:3000`.

To use PostgreSQL for final request/response logs:

```bash
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npm start
```

`PostgresRequestStore` creates the `negotiation_logs` table automatically. Without `DATABASE_URL`, the demo uses `MemoryRequestStore`; those logs are lost when the process exits.

For external callbacks from another machine, set `PUBLIC_BASE_URL` to a publicly reachable HTTPS URL and secure the application or reverse proxy. The generated callback URL contains an unguessable token, but this is not a substitute for your provider's signature verification where available.

## Authentication (auth negotiation, v1.9.0)

Authentication is itself a negotiation: the whole flow runs inside one
logical `NegotiationClient.call()` to the server's auth route, with the
server asking the client for everything it needs via client services.

```
clientAuth <--> authManager (server)          (one negotiation job)
  1. client  -> begin: client.call(authUrl)
  2. server  -> asks `auth.time` over several fast rounds; using the
                fastest sample, client and server clocks must agree
                within 20,000 ms (default), otherwise the negotiation is
                closed (CLOCK_SKEW)
  3. server  -> asks `auth.getUid`; client sends its uid (the server
                resolves the per-user password via its lookup function)
  4. server  -> asks `auth.solveChallenge`, sending the challenge
                encrypted as encryption({data, challenge}, pwd + time\20000):
                AES-256-GCM with key HKDF-SHA256(password,
                bucket = floor(now/20000)). `challenge` is a list of function
                names from the built-in registry of pure functions
                f(x) => y (add1, double, square, xor42, ...)
  5. client  -> resolves the challenge and returns the result,
                encrypted the same way
  6. server  -> validates the result; on success it FIRST saves the token
                to its registry (that save is what marks the auth as
                successful), THEN delivers the token by asking
                `auth.acceptToken`
  7. client  -> stores the token and returns ack; the server marks the
                registry entry acknowledged and the negotiation ends
                (connection closed). When the connection/process closes,
                the client runs a fresh auth negotiation next time.
```

```ts
import { createServer } from "node:http";
import { NegotiationClient, NegotiationServer } from "http-negotiation-protocol";
import { ClientAuthManager, ServerAuthManager } from "http-negotiation-protocol/auth";

// Bind the managers to your negotiation server/client (first argument).
// The server manager registers the /auth route on the negotiation server
// in its constructor (this.server); it never creates an HTTP server of
// its own, and NegotiationServer has no listen() either — you own HTTP.
const negotiationServer = new NegotiationServer();
const authServer = new ServerAuthManager(negotiationServer, {
  getPassword: async (uid) => users[uid],   // per-user password lookup
});
const http = createServer(authServer.requestHandler());
authServer.attach(http);
await authServer.listen(4000);  // starts the attached server: /auth + all negotiation routes

// The client manager registers the auth services (auth.time, auth.getUid,
// auth.solveChallenge, auth.acceptToken) on the negotiation client and
// runs the auth negotiation through it.
const negotiationClient = new NegotiationClient();
const clientAuth = new ClientAuthManager(negotiationClient, {
  authUrl: "http://127.0.0.1:4000/auth",
  uid: "user1",
  password: "correct-horse",
});
const session = await clientAuth.authenticate();  // { token, uid, expiresAt }
// negotiationClient now sends `authorization: Bearer <token>` automatically:
await negotiationClient.call({ url: "http://127.0.0.1:4000/example", data: {} });
authServer.validateToken(session.token);          // registry lookup -> entry?
clientAuth.close();                               // forget token; header no longer sent
```

`ClientAuthManager` must be bound to a `NegotiationClient` (first
argument) — it has no standalone transport of its own. For
`ServerAuthManager`, pass the `NegotiationServer` as the first argument
(or the `server` option), create your HTTP server with
`createServer(authServer.requestHandler())`, `attach()` it to the
manager, and then call `authServer.listen(port)` to start that attached
server (or just call `http.listen(...)` yourself — same thing).
`listen()` rejects when there is no bound server or nothing attached.

Notes:

- Run it over **HTTPS** in production. Passwords are password-equivalents
  (whoever holds one can answer challenges), so source them from a secret
  manager / DB rather than hard-coding them.
- Times are universal: the managers use UTC epoch milliseconds
  (`utcNow()`), and `ServerAuthManager` records its startup instant as
  `startedAtUtc` (ISO 8601 UTC), reset on `listen()`/`attach()`. The
  default clock budget is 20,000 ms for both the accepted skew
  (`maxClockSkewMs`) and the encryption bucket (`timeBucketMs`); use
  NTP-synced hosts and tighten them via options if you need stricter
  timing.
- The auth services only answer while an auth negotiation is in progress,
  and re-authentication overwrites the stored token on success.
- Runnable demo: `npm run demo:auth` (`examples/auth.ts`). The library does
  not yet gate `NegotiationClient.call()` on a token — enforce
  `authServer.validateToken(token)` in your own routes/middleware if you
  want that today.

## Running on Express / other frameworks (v1.7.0)

`NegotiationServer` does not have to own its HTTP server. `requestHandler()`
returns a standard Node `(req, res)` handler implementing the whole protocol
— routes, `/__negotiation/resume`, and external callbacks:

```ts
import express from "express";
import { NegotiationServer } from "http-negotiation-protocol";

const server = new NegotiationServer();
server.handle("/example", /* ... */);

const app = express();
app.use(express.json());           // optional — pre-parsed bodies are honoured
app.get("/health", (req, res) => res.json({ ok: true }));
app.use(server.requestHandler());  // mount at the root, after your own routes
app.listen(3000);
```

Rules:

- **Lifecycle:** with plain `requestHandler()` you own the HTTP server and
  `server.close()` only cleans up jobs/store. Prefer `server.attach(http)`
  (as in `examples/express.ts`): `server.httpServer` is then set, HTTP
  `error`/`close` events are wired (an external close cleans up jobs/store
  exactly once), and a single `await server.close()` closes everything.
- **Mount at the root** (route matching uses the full request path,
  `originalUrl` included). Mount other middleware/routes before or after as
  usual; anything that is not a negotiation route, the resume endpoint, or a
  callback path is left to your app — except that unknown `POST` paths get
  the protocol `404`, so mount negotiation last, or restrict it (below).
- **Koa** works the same via the raw pair: `(ctx) => server.handleRequest(ctx.req, ctx.res)`
  (disable your body parser for negotiation paths, or rely on the
  pre-parsed-body support). **Fastify**: use `server.handleRequest(req.raw, res.raw)`
  with `res.hijack()`. **Plain `node:http`**: `createServer(server.requestHandler())`.
- **Hono / Next.js / fetch-style frameworks** use Web `Request`/`Response`
  and need a fetch adapter — not yet provided; run a plain
  `createServer(server.requestHandler())` + `server.attach(http)` server
  next to them for now (NegotiationServer has no `listen()` of its own).
- Runnable example: `npm run demo:express` (`examples/express.ts`).

## Contract-first typed syntax (v1.6.0) — recommended

Define services/actions **once** in a contract; both sides derive
autocomplete, argument types, and return types from it — no more `any`
proxies:

```ts
import {
  act, createClient, createServer, defineContract, svc,
} from "http-negotiation-protocol";

interface Slot { id: string }

const contract = defineContract({
  client: {
    getName: svc<{ name: string }>(),                              // () -> { name }
    selectSlot: svc<{ slotId: string }, { slots: Slot[] }>(),      // (data) -> { slotId }
    "location.getArea": svc<string, { precise: boolean }>(),
  },
  server: {
    "math.add": act<number, { a: number; b: number }>(),
    "delivery.getAvailableSlots": act<Slot[]>(),
  },
});

const server = createServer(contract);
server.implement({                          // argument/return types checked
  "math.add": async ({ a, b }) => a + b,
  "delivery.getAvailableSlots": async () => [{ id: "slot_1" }],
});

server.handle("/example", async () => {
  const { name } = await server.ask.getName();                     // typed, autocompleted
  const area = await server.ask.location.getArea({ precise: false });
  const sum = await server.run.math.add({ a: 2, b: 3 });           // missing `b` = compile error
  return { name, area, sum };
});

const client = createClient(contract);
client.provide({                            // implementations are checked too
  getName: async () => ({ name: "Alex" }),
  selectSlot: async ({ slots }) => ({ slotId: slots[0]?.id ?? "" }),
  "location.getArea": async () => "Ghardaia-Centre",
});
```

Notes:

- `svc<Result, Data>()` / `act<Result, Data>()` are phantom-typed markers;
  omit `Data` for no-argument services (`svc<{ name: string }>()`).
- `server.implement(...)` and `client.provide(...)` accept **subsets** —
  register the rest in a later call. Names outside the contract are
  rejected at runtime, as are `server.ask.*` calls outside the contract.
- Typed proxies expose full dotted paths (`server.ask.location.getArea()`);
  the classic/untyped `NegotiationServer` / `NegotiationClient` (and
  `server.use` / `client.use`) are unchanged.

## Shortest syntax (v1.3.0, magic proxies)

No string service/action names inside routes, and `return` replaces `server.end()`:

```ts
import { createServer as createHttpServer } from "node:http";
import { NegotiationClient, NegotiationServer } from "http-negotiation-protocol";

const server = new NegotiationServer();
const client = new NegotiationClient();

server.use({ "math.add": ({ a, b }) => a + b });

server.handle("/example", async () => {
  const name = await server.ask.getName();          // client service "getName"
  const sum = await server.run.math.add({ a: 2, b: 3 }); // server action "math.add"
  return { name, sum };                             // returning a value auto-ends the job
});

client.use({ getName: async () => "Alex" });

// NegotiationServer has no listen(): the application owns the HTTP server.
const httpServer = createHttpServer(server.requestHandler());
server.attach(httpServer);
await new Promise<void>((resolve) => httpServer.listen(3000, "127.0.0.1", resolve));
const result = await client.call({ url: "http://127.0.0.1:3000/example", data: {} });
console.log(result); // { name: "Alex", sum: 5 }
await server.close();
```

Proxy rules:

- `server.ask.<name>(data)` → `server.require("<name>", data)`; nest for dots: `server.ask.location.get()` → `"location.get"`.
- `server.run.<name>(data)` → server actions; nest for dots (`server.run.math.add()`), use a bare leaf (`server.run.getAvailableSlots()` resolves `"delivery.getAvailableSlots"`), or a normalised name (`server.run.mathAdd()` → `"math.add"`). Ambiguous leaf names throw — use the full dotted path.
- The classic string API (`server.require(...)`, `server.call(...)`, `server.end(...)`,
  `server.requireMany(...)` for parallel calls with `fallback`) remains fully supported
  and is still the way to pass fallbacks, explicit types, or low-level action results.

## Batch syntax (v1.4.0, `server.asks()`)

Chain several client services without awaiting them — they all execute in
**one negotiation round, in parallel** when you call `done()`:

```ts
const asks = server.asks();
asks.selectDeliverySlot({
  orderId: input.orderId,
  slots,
  fragileHandling: preferences.fragileHandling,
}).getNames();              // no arguments = `data` is undefined

const results = await asks.done();
results[0];                 // first result, in call order
results.selectDeliverySlot; // same result, by service name
```

- Destructure if you prefer: `const [slot, names] = await asks.done();`
- Dotted names chain too: `asks.location.getArea()` → `"location.getArea"`
  (results are attached under both `results["location.getArea"]` and `results.getArea`).
- Per-call fallback: `asks.getCurrentLocation({}, { fallback: null })`.
- The builder is single-use (`done()` throws if called twice) and is also
  awaitable itself: `const results = await server.asks().getNames();`

### Same builder for server actions: `server.runs()` (v1.5.0)

Mirror of `asks()` for server-side actions. Actions are local (no network
round), but the builder is handy when several independent actions belong
together. They execute **in parallel** on `done()`:

```ts
const runs = server.runs();
runs.math.add({ a: 2, b: 3 }).delivery.getAvailableSlots({ period: "morning" });

const results = await runs.done();
results[0];          // 5, in call order
results.add;         // 5, by leaf action name
results["math.add"]; // 5, by full dotted name
```

- Name resolution matches `server.run.*`: nested (`runs.math.add()`), bare
  leaf (`runs.getAvailableSlots()`), or normalised (`runs.mathAdd()`).
- Per-call fallback: `runs.explode(data, { fallback: "recovered" })`; without
  a fallback, the first failure rejects `done()`.
- Single-use builder, and awaitable directly:
  `const results = await server.runs().math.add({ a: 1, b: 2 });`

## Minimal API (classic syntax)

```ts
import { createServer as createHttpServer } from "node:http";
import { NegotiationClient, NegotiationServer } from "http-negotiation-protocol";

const server = new NegotiationServer();
const client = new NegotiationClient();

server.use({
  "math.add": ({ a, b }) => a + b,
});

server.handle("/example", async () => {
  const name = await server.require<string>("getName", {});
  const sum = await server.call<number>("math.add", { a: 2, b: 3 });
  await server.end({ name, sum });
});

client.use({
  getName: async () => "Alex",
});

// NegotiationServer has no listen(): the application owns the HTTP server.
const httpServer = createHttpServer(server.requestHandler());
server.attach(httpServer);
await new Promise<void>((resolve) => httpServer.listen(3000, "127.0.0.1", resolve));
const result = await client.call({
  url: "http://127.0.0.1:3000/example",
  data: {},
});
console.log(result); // { name: "Alex", sum: 5 }
await server.close();
```

## Public methods

### Client

- `client.use(plugin).use(services)` registers HTTP interceptors and client services.
- `client.call({ url, params, data, headers })` runs all negotiation rounds and returns the final result.

### Server

- `server.handle(path, handler)` registers an HTTP route.
- `server.require(name, data)` asks the client to execute one service and returns its result. A failed service throws an Error; handle it with `try/catch`.
- `server.requireMany([{ name, data, fallback }])` executes several client services in parallel in one negotiation round. `fallback` is used if that service fails; an omitted fallback means failure throws.
- `server.use(actions)` registers server-side actions.
- `await server.call(name, data)` runs a server-side action.
- `await server.callback(name, data, callbackPath?)` runs a server-side action that receives a generated `callbackUrl`, then waits for the external provider's POST result. No callback IDs or tokens are exposed to route code.
- `server.requestHandler()` / `server.attach(httpServer)` / `await server.close()` host the protocol on an HTTP server you own: create it with `createServer(server.requestHandler())`, attach it, and call `http.listen(...)` yourself. There is intentionally no `server.listen()`.
- `await server.end(result)` sends and stores the final result. A handler that returns a value without calling `end()` automatically ends with that value.
- `server.respond(request, result)` remains available for code that prefers setting the result separately before `end()`.
- `server.plugin(plugin | plugin[])` registers server plugins (job lifecycle hooks, below).

### Server plugins

A `ServerPlugin` observes — and can veto — every negotiation job through
four awaited hooks, run in registration order:

```ts
import { NegotiationServer, type ServerPlugin } from "http-negotiation-protocol/server";

const timing: ServerPlugin = {
  name: "timing",
  onJobStart: ({ jobId, path }) => console.log(`job ${jobId} started on ${path}`),
  onRound:    ({ round, actions }) => console.log(`round ${round}: ${actions.map((a) => a.name).join(", ")}`),
  onJobEnd:   ({ result }) => console.log("finished:", result),
  onJobError: ({ error }) => console.error("failed:", error.message),
};

const server = new NegotiationServer();
server.plugin(timing); // or server.plugin([timing, anotherPlugin])
```

Every hook receives the job context (`jobId`, `path`, `method`, `origin`,
`round`, `startedAt`, `request`); `onRound` adds the round's `actions`,
`onJobEnd` the final `result`, and `onJobError` the `error`. Error semantics
mirror middleware: throwing from `onJobStart`/`onRound` **fails the job**
(the client receives the error and `onJobError` fires), while throwing from
`onJobEnd`/`onJobError` is only reported through the server's `onError`
option and never changes the outcome. The client has the symmetric HTTP
plugin API (`client.use({ onRequest, onResponse, onError })`).

## Protocol behavior

- The first request starts a job. Every server negotiation response uses `done: false`; the final one uses `done: true`.
- Client services are allow-listed by registering them with `client.use({ serviceName: fn })`.
- The library generates `jobId`, `callbackID`, and private resume tokens internally.
- Results are matched to the expected callback IDs; repeated external callbacks are acknowledged without settling the callback again.
- `Server.end(result)` saves the original request and final response through the configured `RequestStore`.
- Active jobs are held in memory. This version targets one server process; it does not recover pending jobs after a restart or coordinate multiple replicas.

## Options (v1.2.0)

### Server — `new NegotiationServer({...})`

| Option | Default | Purpose |
| --- | --- | --- |
| `maxBodyBytes` | `1_000_000` | Maximum JSON request body size |
| `requestTimeoutMs` | `120_000` | Timeout for one negotiation round / external callback |
| `jobTimeoutMs` | `600_000` | Overall lifetime of one logical job (`JOB_EXPIRED` afterwards) |
| `maxJobs` | `1000` | Maximum active jobs; new jobs get HTTP `503 TOO_MANY_JOBS` beyond this |
| `onError(error, { jobId, path, phase })` | — | Structured error hook |

### Client — `new NegotiationClient({...})` / `client.call({...})`

| Option | Default | Purpose |
| --- | --- | --- |
| `serviceTimeoutMs` | `60_000` | Timeout for one client service |
| `requestTimeoutMs` | `120_000` | Timeout for one HTTP request |
| `maxRounds` | `100` | Round cap per logical call (`MAX_ROUNDS_EXCEEDED`; also per-call) |
| `maxResponseBytes` | `1_000_000` | Maximum accepted response size (`RESPONSE_TOO_LARGE`) |
| `signal` (per call) | — | `AbortSignal` cancelling the whole logical call |

## Security behaviour (v1.2.0)

- Resume tokens are **rotated every round** and are single-round; callback and
  resume tokens are stored only as SHA-256 hashes and compared in constant time.
- Sensitive headers (`Authorization`, `Cookie`, `x-api-key`, …) are persisted
  as `[REDACTED]` — credentials are never written to a `RequestStore`.
- Abandoned jobs expire instead of leaking in memory, and `server.close()`
  rejects pending rounds/callbacks instead of hanging.

## Development

```bash
npm install
npm run lint       # ESLint
npm run typecheck  # strict TypeScript (incl. noUncheckedIndexedAccess)
npm test           # node:test via tsx (9 tests)
npm run build      # library only -> dist/ (declarations + source maps)
npm run demo       # examples/demo.ts
```

Publishing: the package entry point is `dist/index.js` (`exports` map in
`package.json`); `.github/workflows/publish.yml` publishes to npm on a GitHub
Release using the `NPM_TOKEN` repository secret.

## Production considerations

1. Use HTTPS and authenticate the initial business endpoints.
2. Validate callback signatures from external providers, not only the callback token.
3. Treat client service names as allow-listed capabilities; never execute arbitrary code supplied in protocol messages.
4. Set limits and timeouts on HTTP bodies, services, jobs, and external callbacks.
5. Move active job state to durable shared storage before using multiple server replicas or requiring restart recovery.
6. Use a durable store rather than `MemoryRequestStore` when request/response logs must survive restarts.
