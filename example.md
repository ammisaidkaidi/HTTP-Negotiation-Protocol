# HTTP Negotiation Protocol — 5 Examples

Install:

```bash
npm install http-negotiation-protocol
```

Imports come from the two side-specific entry points:

```ts
import { NegotiationClient } from "http-negotiation-protocol/client";
import { NegotiationServer } from "http-negotiation-protocol/server";
```

One rule applies to every server example below: **`NegotiationServer` has no
`listen()`** — your application owns the HTTP server. Create it from
`server.requestHandler()`, `attach()` it (so `server.close()` also closes
HTTP), and call `http.listen(...)` yourself.

---

## 1. Minimal negotiation — client service + server action

The server asks the client for a name (`server.ask.*`) and runs one of its own
actions (`server.run.*`). The client exposes `getName` as a service. `return`
in the handler ends the job with that result.

**Server**

```ts
import { createServer as createHttpServer } from "node:http";
import { NegotiationServer } from "http-negotiation-protocol/server";

const server = new NegotiationServer();

server.use({
  "math.add": async ({ a, b }: { a: number; b: number }) => a + b,
});

server.handle("/example", async () => {
  const name = await server.ask.getName();              // client service "getName"
  const sum = await server.run.math.add({ a: 2, b: 3 }); // server action "math.add"
  return { name, sum };
});

const http = createHttpServer(server.requestHandler());
server.attach(http);
await new Promise<void>((resolve) => http.listen(3000, "127.0.0.1", resolve));
```

**Client**

```ts
import { NegotiationClient } from "http-negotiation-protocol/client";

const client = new NegotiationClient();
client.use({ getName: async () => "Alex" });

const result = await client.call({
  url: "http://127.0.0.1:3000/example",
  data: {},
});
console.log(result); // { name: "Alex", sum: 5 }
```

---

## 2. Batching — many services in one round (`asks()` / `runs()`)

Chained `asks()` calls are sent to the client as **one negotiation round** and
run in parallel. `runs()` does the same for local server actions. Per-call
`{ fallback }` values are used when that service/action fails.

**Server**

```ts
import { createServer as createHttpServer } from "node:http";
import { NegotiationServer } from "http-negotiation-protocol/server";

const server = new NegotiationServer();

server.use({
  "math.add": async ({ a, b }: { a: number; b: number }) => a + b,
  "math.multiply": async ({ a, b }: { a: number; b: number }) => a * b,
});

server.handle("/summary", async (request) => {
  const input = request.data as { a: number; b: number };

  // One round trip: both client services execute in parallel.
  const asks = server.asks();
  asks.getProfile().getPreferences({ fallback: { theme: "light" } });
  const [profile, preferences] = await asks.done();

  // Local actions, executed in parallel on done().
  const runs = server.runs();
  runs.math.add(input).math.multiply(input);
  const totals = await runs.done();

  return { profile, preferences, sum: totals.add, product: totals.multiply };
});

const http = createHttpServer(server.requestHandler());
server.attach(http);
await new Promise<void>((resolve) => http.listen(3000, "127.0.0.1", resolve));
```

**Client**

```ts
import { NegotiationClient } from "http-negotiation-protocol/client";

const client = new NegotiationClient();
client.use({
  getProfile: async () => ({ name: "Alex", plan: "pro" }),
  getPreferences: async () => ({ theme: "dark" }),
});

const result = await client.call({
  url: "http://127.0.0.1:3000/summary",
  data: { a: 4, b: 3 },
});
console.log(result);
// { profile: { name: "Alex", plan: "pro" }, preferences: { theme: "dark" }, sum: 7, product: 12 }
```

---

## 3. External callback — wait for a provider webhook (`server.callback()`)

`server.callback()` runs a server action, injects a signed `callbackUrl` into
its data, and suspends the job until the provider POSTs the result to that
URL. The simulated carrier below calls back from the same process; a real
provider needs `publicBaseUrl` set to a publicly reachable HTTPS URL.

**Server**

```ts
import { createServer as createHttpServer } from "node:http";
import { NegotiationServer } from "http-negotiation-protocol/server";

const server = new NegotiationServer({
  // Only needed when the provider is on another machine:
  publicBaseUrl: process.env.PUBLIC_BASE_URL, // e.g. "https://api.example.com"
});

server.use({
  // In production you would send callbackUrl to the provider's API here.
  "carrier.requestQuote": async ({ orderId, callbackUrl }: { orderId: string; callbackUrl: string }) => {
    setTimeout(() => {
      void fetch(callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId: "QUOTE-77", feeDzd: 750, etaMinutes: 85 }),
      });
    }, 150);
    return { accepted: true };
  },
});

server.handle("/delivery/estimate", async (request) => {
  const { orderId } = request.data as { orderId: string };
  const quote = await server.callback<{ quoteId: string; feeDzd: number; etaMinutes: number }>(
    "carrier.requestQuote",
    { orderId },
  );
  return { orderId, shipping: quote };
});

const http = createHttpServer(server.requestHandler());
server.attach(http);
await new Promise<void>((resolve) => http.listen(3000, "127.0.0.1", resolve));
```

**Client**

```ts
import { NegotiationClient } from "http-negotiation-protocol/client";

const client = new NegotiationClient();
const result = await client.call({
  url: "http://127.0.0.1:3000/delivery/estimate",
  data: { orderId: "ORD-1" },
});
console.log(result);
// { orderId: "ORD-1", shipping: { quoteId: "QUOTE-77", feeDzd: 750, etaMinutes: 85 } }
```

---

## 4. Express (or any Node framework) — the server plugs into your app

`requestHandler()` returns a standard Node `(req, res)` handler, so the
protocol mounts into an existing app. Attach the HTTP server so
`server.close()` also closes HTTP and lifecycle events are wired.

**Server**

```ts
import { createServer as createHttpServer } from "node:http";
import express from "express";
import { NegotiationServer } from "http-negotiation-protocol/server";

const server = new NegotiationServer();
server.handle("/example", async () => {
  const name = await server.ask.getName();
  return { greeting: `Hello ${name}` };
});

const app = express();
app.use(express.json()); // optional — pre-parsed bodies are honoured
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(server.requestHandler()); // mount at the root, after your own routes

const http = createHttpServer(app);
server.attach(http);
await new Promise<void>((resolve) => http.listen(3000, "127.0.0.1", resolve));
```

**Client**

```ts
import { NegotiationClient } from "http-negotiation-protocol/client";

const client = new NegotiationClient();
client.use({ getName: async () => "Alex" });

const result = await client.call({
  url: "http://127.0.0.1:3000/example",
  data: {},
});
console.log(result); // { greeting: "Hello Alex" }
```

---

## 5. Plugins on both sides — HTTP interceptors + job lifecycle hooks

The client accepts HTTP plugins (`onRequest` / `onResponse` / `onError`,
applied to every round), and the server accepts `ServerPlugin` lifecycle
hooks (`onCallStart` / `onRound` / `onCallEnd` / `onCallError`). Throwing from
`onCallStart`/`onRound` fails the job; throwing from `onCallEnd`/`onCallError`
is only reported through the server's `onError` option.

**Server**

```ts
import { createServer as createHttpServer } from "node:http";
import { handledResult, NegotiationServer, type ServerPlugin } from "http-negotiation-protocol/server";

const audit: ServerPlugin = {
  name: "audit",
  onCallStart: ({ jobId, path }) => console.log(`job ${jobId} started on ${path}`),
  onRound: ({ round, actions }) =>
    console.log(`round ${round}: ${actions.map((a) => a.name).join(", ")}`),
  onCallEnd: ({ result }) => console.log("finished:", result),
  onCallError: ({ error }) => console.error("failed:", error.message),
};

// A server plugin can also answer a job itself: returning handledResult()
// from onCallStart skips the remaining onCallStart plugins and the route
// handler, and the job ends normally with that result (onCallEnd still fires).
const cache: ServerPlugin = {
  name: "cache",
  onCallStart: ({ request }) => {
    if (request.path === "/example") return handledResult({ greeting: "Hello (cached)" });
  },
};

const server = new NegotiationServer();
server.plugin([cache, audit]); // or server.plugin(audit)

server.handle("/example", async () => {
  const name = await server.ask.getName();
  return { greeting: `Hello ${name}` };
});

const http = createHttpServer(server.requestHandler());
server.attach(http);
await new Promise<void>((resolve) => http.listen(3000, "127.0.0.1", resolve));
```

**Client**

```ts
import { NegotiationClient } from "http-negotiation-protocol/client";

const client = new NegotiationClient();
client
  .use({
    onRequest: (request) => {
      request.headers["x-trace-id"] = crypto.randomUUID();
    },
    onResponse: (_body, response) => console.log(response.phase, "HTTP", response.status),
    onError: (error) => console.error("request failed:", error.message),
  })
  .use({ getName: async () => "Alex" });

const result = await client.call({
  url: "http://127.0.0.1:3000/example",
  data: {},
});
console.log(result); // { greeting: "Hello Alex" }
```

The client chain is a permit/hold pipeline: hooks are awaited in order, so
an async hook can hold the request, and any `onRequest` hook can stop it
before fetch — return `false` (or call `haltRequest("reason")`, imported
from `http-negotiation-protocol/client`) to reject `client.call()` with a
coded `REQUEST_HALTED` error that `onError` hooks also observe:

```ts
client.use({
  onRequest: async (request) => {
    const allowed = await checkPermission(request.url); // may hold the request
    if (!allowed) return false; // halt: fetch and later plugins never run
    request.headers["x-permitted"] = "yes";
  },
});
```
