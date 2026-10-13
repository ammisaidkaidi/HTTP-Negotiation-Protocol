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

## Minimal API

```ts
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

await server.listen(3000);
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
- `await server.end(result)` sends and stores the final result. A handler that returns a value without calling `end()` automatically ends with that value.
- `server.respond(request, result)` remains available for code that prefers setting the result separately before `end()`.

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
