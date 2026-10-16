# HTTP Negotiation Protocol — Examples

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

---

## 6. Concurrent calls on one client instance (`Promise.all`)

One `NegotiationClient` instance **can** run many `client.call()` operations
at the same time. All per-call state (rounds, jobId, resume token) is local
to each `call()`; the instance only shares services, plugins and timeouts.
Each call becomes an independent job on the server (up to `maxJobs`,
default 1000, then `503 TOO_MANY_JOBS`). There is no built-in queue or
concurrency limit — every call starts immediately (see Example 9 to add one).

**Server**

```ts
server.handle("/price", async (request) => {
  const { sku } = request.data as { sku: string };
  const local = await server.ask.lookupPrice({ sku }); // client service
  return { sku, price: local };
});
```

**Client**

```ts
const client = new NegotiationClient();
client.use({
  // NOTE: services run concurrently too — keep them stateless or
  // concurrency-safe (no shared mutable counters without locking).
  lookupPrice: async ({ sku }: { sku: string }) => priceBook[sku],
});

const [a, b, c] = await Promise.all([
  client.call({ url: "http://127.0.0.1:3000/price", data: { sku: "A" } }),
  client.call({ url: "http://127.0.0.1:3000/price", data: { sku: "B" } }),
  client.call({ url: "http://127.0.0.1:3000/price", data: { sku: "C" } }),
]);
console.log(a, b, c);
```

---

## 7. Server holds a request — suspended handler waiting for your own event

The server holds the **logical** request, not the HTTP socket: whenever the
handler awaits (a client service, `server.callback(...)`, or any promise of
your own), the job is parked in memory and the handler resumes exactly
where it stopped. Other requests keep flowing meanwhile.

```ts
import { EventEmitter, once } from "node:events";

const server = new NegotiationServer({
  jobTimeoutMs: 30 * 60_000, // a held job may live up to 30 min (default 600_000)
});
const payments = new EventEmitter();

server.handle("/checkout", async (request) => {
  const { orderId } = request.data as { orderId: string };

  // The job is HELD here — no HTTP connection is kept open — until some
  // other part of your app confirms the payment.
  const [payment] = await once(payments, `paid:${orderId}`);
  return { orderId, status: "paid", payment };
});

// Elsewhere in your app (webhook route, message consumer, admin action...):
payments.emit("paid:ORD-9", { transactionId: "tx_123" });
```

Held jobs live only in this process's memory and are bounded by
`jobTimeoutMs` overall (`requestTimeoutMs` bounds each individual round
waiting for client results). `server.close()` rejects everything suspended.

---

## 8. Server plugin halts a request and answers it itself (`handledResult`)

An `onCallStart` server plugin can **respond to the client and stop the
rest of the pipeline**: return `handledResult(result)` and the remaining
start plugins and the route handler are skipped; `client.call()` resolves
with that result and `onCallEnd` still fires. Throwing instead fails the
call (`client.call()` rejects, `onCallError` fires). Only `onCallStart`
can short-circuit, and plugins never see the raw `res` — for raw HTTP
control use `server.setPreHandler((req, res) => ...)` (returns `true` to
claim the request before negotiation routing).

```ts
import { handledResult, NegotiationServer, type ServerPlugin } from "http-negotiation-protocol/server";

// A "json guard": validates the payload and answers bad calls itself.
const jsonGuard: ServerPlugin = {
  name: "json-guard",
  onCallStart: ({ request }) => {
    if (request.path !== "/orders") return;              // not our route: continue
    const data = request.data as { items?: unknown[] } | null;
    if (!data || !Array.isArray(data.items) || data.items.length === 0) {
      // Halt: handler never runs, client receives this as the final result.
      return handledResult({ ok: false, error: "items must be a non-empty array" });
    }
    // return nothing → the call continues to the route handler
  },
};

const server = new NegotiationServer();
server.plugin(jsonGuard);
server.handle("/orders", async () => ({ ok: true })); // only valid calls reach this
```

---

## 9. Request-queue patterns (userland) — one-by-one, max-N, LIFO, latest-only

The client has no built-in queue: every `call()` starts at once. If you
need an execution policy, wrap the client. The queue schedules **whole
logical calls** (rounds inside one call always stay together, in order).

```ts
import { NegotiationClient, type ClientCallRequest } from "http-negotiation-protocol/client";

interface QueueOptions {
  maxConcurrent?: number;      // default 1
  order?: "fifo" | "lifo";     // default "fifo"
  supersedeQueued?: boolean;   // drop still-queued calls when a new one arrives
}

interface Entry {
  request: ClientCallRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

export class CallQueue {
  private running = 0;
  private queued: Entry[] = [];
  constructor(
    private client: NegotiationClient,
    private options: QueueOptions = {},
  ) {}

  call(request: ClientCallRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.options.supersedeQueued) {
        for (const dropped of this.queued.splice(0)) {
          dropped.reject(Object.assign(
            new Error("Superseded by a newer call"), { code: "REQUEST_SUPERSEDED" }));
        }
      }
      const entry: Entry = { request, resolve, reject };
      if (request.signal) {
        entry.onAbort = () => {
          const i = this.queued.indexOf(entry);
          if (i >= 0) { // aborted while still queued: never starts
            this.queued.splice(i, 1);
            reject(Object.assign(new Error("Call aborted"), { code: "ABORTED" }));
          }
        };
        request.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queued.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    const max = this.options.maxConcurrent ?? 1;
    while (this.running < max && this.queued.length > 0) {
      const entry = this.options.order === "lifo" ? this.queued.pop()! : this.queued.shift()!;
      this.running += 1;
      this.client.call(entry.request)
        .then(entry.resolve, entry.reject)
        .finally(() => { this.running -= 1; this.pump(); });
    }
  }
}
```

The policies we discussed are just configurations of this one queue:

```ts
const oneByOne = new CallQueue(client);                                        // serial, FIFO
const pool     = new CallQueue(client, { maxConcurrent: 3 });                  // max 3 at a time
const stack    = new CallQueue(client, { maxConcurrent: 1, order: "lifo" });   // last one first
const latest   = new CallQueue(client, { maxConcurrent: 1, supersedeQueued: true }); // newest wins

const result = await pool.call({ url: "http://127.0.0.1:3000/price", data: { sku: "A" } });
```

Variants worth knowing: add a per-entry `priority` and sort on `shift()`
for priority queues; key the queue by route/tenant for per-key fairness;
or use separate `NegotiationClient` instances when policies must be fully
isolated (different services/plugins per policy).

---

## 10. Small patterns — cancellation and retry

**Cancel one logical call** with an `AbortSignal` (queued calls in
Example 9 honour it too; the server job expires on its own):

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000); // give up after 5s
await client.call({ url, data, signal: controller.signal });
```

**Retry only coded, retryable failures** — never blind-retry a whole
negotiation (it starts a brand-new job each attempt):

```ts
async function callWithRetry(request: ClientCallRequest, attempts = 3): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.call(request);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= attempts || !["TOO_MANY_JOBS", "ABORTED"].includes(code ?? "")) throw error;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}
```
