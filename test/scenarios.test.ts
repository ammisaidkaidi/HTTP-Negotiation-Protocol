import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import express from "express";
import {
  createClient,
  haltRequest,
  NegotiationClient,
  RequestHaltedError,
} from "../src/client/index.js";
import {
  defineAction,
  defineContract,
  defineService,
  type ClientPlugin,
} from "../src/common/negotiations.js";
import {
  createServer,
  NegotiationServer,
  type ServerPlugin,
} from "../src/server/index.js";

// ---------------------------------------------------------------------------
// Shared rig: a real NegotiationServer + NegotiationClient over HTTP, with a
// standard set of routes/actions/services that the scenarios exercise.
// ---------------------------------------------------------------------------

interface Ctx {
  events: string[];
  serviceCalls: Record<string, number>;
  capturedCallbackUrls: string[];
  callbackPayloads: unknown[];
}

interface Rig {
  ctx: Ctx;
  server: NegotiationServer;
  baseUrl: string;
  makeClient: (services?: Record<string, (data?: any) => unknown>, plugins?: ClientPlugin[]) => NegotiationClient;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildServer(ctx: Ctx, server: NegotiationServer): void {
  server.use({
    "math.add": async ({ a, b }: { a: number; b: number }) => a + b,
    "math.multiply": async ({ a, b }: { a: number; b: number }) => a * b,
    "text.shout": async ({ text }: { text: string }) => text.toUpperCase(),
    "delivery.getAvailableSlots": async ({ period }: { period: string }) =>
      period === "morning" ? [{ id: "slot_09_11" }] : [{ id: "slot_14_16" }],
    "fail.boom": async () => { throw new Error("action exploded"); },
    "carrier.requestQuote": async ({ orderId, callbackUrl }: { orderId: string; callbackUrl: string }) => {
      ctx.capturedCallbackUrls.push(callbackUrl);
      setTimeout(() => {
        void fetch(callbackUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ quoteId: `Q-${orderId}`, feeDzd: 750, etaMinutes: 85 }),
        }).catch(() => undefined); // job may already be settled manually in a scenario
      }, 20);
      return { accepted: true };
    },
    "carrier.never": async () => ({ accepted: true }),
    "counter.next": async () => { ctx.events.push("count"); return ctx.events.filter((e) => e === "count").length; },
    "carrier.fail": async () => { throw new Error("carrier down"); },
  });

  server.handle("/echo", async (request) => request.data);
  server.handle("/echo-meta", async (request) => ({
    params: request.params,
    demoHeader: request.headers["x-demo"] ?? null,
    data: request.data,
  }));
  server.handle("/greet", async (request) => {
    const data = request.data as { a: number; b: number };
    const name = await server.ask.getName();
    const sum = await server.run.math.add(data);
    return { name, sum };
  });
  server.handle("/ask-two", async () => {
    const name = await server.ask.getName();
    const city = await server.ask.getCity();
    return { name, city };
  });
  server.handle("/ask-mirror", async (request) => server.ask.mirror(request.data));
  server.handle("/ask-dotted", async () => server.ask.location.getArea({ precise: true }));
  server.handle("/ask-chain", async () => {
    const name = await server.ask.getName() as string;
    return server.run.text.shout({ text: name });
  });
  server.handle("/batch", async () => {
    const asks = server.asks();
    asks.getProfile().getPreferences();
    const batch = await asks.done();
    const runs = server.runs();
    runs.math.add({ a: 2, b: 3 }).math.multiply({ a: 2, b: 3 });
    const totals = await runs.done();
    return { profile: batch[0], preferences: batch.getPreferences, sum: totals.add, product: totals["math.multiply"] };
  });
  server.handle("/asks-named", async () => {
    const asks = server.asks();
    asks.getName().location.getArea({ precise: false });
    const results = await asks.done();
    return { byLeaf: results.getArea, byFull: results["location.getArea"], first: results[0] };
  });
  server.handle("/asks-fallback", async () => {
    const asks = server.asks();
    asks.explode({}, { fallback: "recovered" }).getName();
    return asks.done();
  });
  server.handle("/asks-no-fallback", async () => {
    const asks = server.asks();
    asks.explode({});
    return asks.done();
  });
  server.handle("/asks-empty", async () => server.asks().done());
  server.handle("/asks-awaitable", async () => {
    const results = await server.asks().getName();
    return results[0];
  });
  server.handle("/asks-double-done", async () => {
    const builder = server.asks().getName();
    await builder.done();
    try {
      await builder.done();
      return "no-throw";
    } catch (error) {
      return (error as Error).message;
    }
  });
  server.handle("/runs-fallback", async () => {
    const runs = server.runs();
    runs.fail.boom({}, { fallback: "recovered" }).math.add({ a: 1, b: 1 });
    return runs.done();
  });
  server.handle("/runs-no-fallback", async () => {
    const runs = server.runs();
    runs.fail.boom({});
    return runs.done();
  });
  server.handle("/runs-names", async () => {
    const runs = server.runs();
    runs.mathAdd({ a: 5, b: 5 }).getAvailableSlots({ period: "morning" });
    const results = await runs.done();
    return { byLeaf: results.add, slots: results.getAvailableSlots };
  });
  server.handle("/single-fallback", async () =>
    server.requestService([{ name: "explode", fallback: "fb" }]));
  server.handle("/quote", async (request) => {
    const { orderId } = request.data as { orderId: string };
    const quote = await server.callback("carrier.requestQuote", { orderId });
    return { orderId, quote };
  });
  server.handle("/quote-slow", async (request) => {
    const { orderId } = request.data as { orderId: string };
    const quote = await server.callback("carrier.requestQuote", { orderId });
    await sleep(80); // window in which a duplicate callback can arrive
    return { orderId, quote };
  });
  server.handle("/quote-fn", async (request) => {
    const quote = await server.createCallback(
      request,
      server.call("carrier.requestQuote", { orderId: "ORD-FN" }),
      (payload: unknown) => { ctx.callbackPayloads.push(payload); },
    );
    return quote;
  });
  server.handle("/quote-never", async () => server.callback("carrier.never", { orderId: "ORD-X" }));
  server.handle("/quote-fail", async () => server.callback("carrier.fail", { orderId: "ORD-X" }));
  server.handle("/explicit-end", async () => { await server.end({ via: "end" }); });
  server.handle("/respond-end", async (request) => {
    server.respond(request, { via: "respond" });
    await server.end();
  });
  server.handle("/return-undefined", async () => undefined);
  server.handle("/ask-three", async () => {
    const name = await server.ask.getName();
    const city = await server.ask.getCity();
    const area = await server.ask.location.getArea({ precise: true });
    return { name, city, area };
  });
  server.handle("/quote-custom-path", async (request) => {
    const { orderId } = request.data as { orderId: string };
    const quote = await server.callback("carrier.requestQuote", { orderId }, "/hooks/carrier");
    return { orderId, quote };
  });
  server.handle("/count", async () => server.run.counter.next({}));
  server.handle("/fail-handler", async () => { throw new Error("handler exploded"); });
  server.handle("/fail-coded", async () => {
    throw Object.assign(new Error("teapot"), { code: "TEAPOT" });
  });
  server.handle("/unknown-service", async () => server.ask.no.suchService());
  server.handle("/unknown-action", async () => server.run.no.suchAction());
  server.handle("/loop", async () => {
    for (;;) {
      await server.ask.ping();
    }
  });
  server.handle("/slow-service", async () => server.ask.slowPing());
}

function defaultServices(ctx: Ctx): Record<string, (data?: any) => unknown> {
  const counted = (name: string, fn: (data?: any) => unknown) => async (data?: any) => {
    ctx.serviceCalls[name] = (ctx.serviceCalls[name] ?? 0) + 1;
    return fn(data);
  };
  return {
    getName: counted("getName", async () => "Alex"),
    getCity: counted("getCity", async () => "Graz"),
    getProfile: counted("getProfile", async () => ({ name: "Alex", plan: "pro" })),
    getPreferences: counted("getPreferences", async () => ({ theme: "dark" })),
    "location.getArea": counted("location.getArea", async () => "Ghardaia-Centre"),
    mirror: counted("mirror", async (data: any) => data),
    ping: counted("ping", async () => 1),
    slowPing: counted("slowPing", async () => { await sleep(400); return 1; }),
    explode: counted("explode", async () => {
      throw Object.assign(new Error("service exploded"), { code: "SERVICE_BOOM" });
    }),
  };
}

async function withRig(
  fn: (rig: Rig) => Promise<void>,
  options: {
    requestTimeoutMs?: number;
    jobTimeoutMs?: number;
    customize?: (server: NegotiationServer, ctx: Ctx) => void;
  } = {},
): Promise<void> {
  const ctx: Ctx = { events: [], serviceCalls: {}, capturedCallbackUrls: [], callbackPayloads: [] };
  const server = new NegotiationServer({
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    ...(options.jobTimeoutMs !== undefined ? { jobTimeoutMs: options.jobTimeoutMs } : {}),
  });
  buildServer(ctx, server);
  options.customize?.(server, ctx);
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test server");
  const rig: Rig = {
    ctx,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    makeClient: (services = {}, plugins = []) => {
      const client = new NegotiationClient();
      if (plugins.length > 0) client.use(plugins);
      client.use({ ...defaultServices(ctx), ...services });
      return client;
    },
    close: () => server.close(),
  };
  try {
    await fn(rig);
  } finally {
    await rig.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario registry — exactly 100 scenarios.
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  run: () => Promise<void>;
}
const scenarios: Scenario[] = [];
const add = (name: string, run: () => Promise<void>) => { scenarios.push({ name, run }); };
const call = (rig: Rig, path: string, data: unknown = {}, services?: Record<string, (data?: any) => unknown>) =>
  rig.makeClient(services).call({ url: `${rig.baseUrl}${path}`, data });

// A. Echo / data round-trips (10)
const echoPayloads: Array<[string, unknown]> = [
  ["string", "hello"],
  ["number", 42],
  ["boolean", true],
  ["null", null],
  ["float", 3.14],
  ["array", [1, "two", false]],
  ["nested object", { user: { id: 7, tags: ["a", "b"] } }],
  ["empty object", {}],
  ["unicode", "négociation ✓"],
  ["large array", Array.from({ length: 100 }, (_, i) => i)],
];
for (const [label, payload] of echoPayloads) {
  add(`A echo round-trips ${label}`, () => withRig(async (rig) => {
    assert.deepEqual(await call(rig, "/echo", payload), payload);
  }));
}

// B. Basic ask/run (12)
add("B ask one client service", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/greet", { a: 1, b: 2 }), { name: "Alex", sum: 3 });
}));
add("B two sequential asks", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/ask-two"), { name: "Alex", city: "Graz" });
}));
add("B ask passes data to the client service", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/ask-mirror", { orderId: "ORD-9", fragile: true }), { orderId: "ORD-9", fragile: true });
}));
add("B run one server action", () => withRig(async (rig) => {
  const result = await call(rig, "/greet", { a: 10, b: 5 }) as { sum: number };
  assert.equal(result.sum, 15);
}));
add("B ask dotted client service", () => withRig(async (rig) => {
  assert.equal(await call(rig, "/ask-dotted"), "Ghardaia-Centre");
}));
add("B ask result feeds a server action", () => withRig(async (rig) => {
  assert.equal(await call(rig, "/ask-chain"), "ALEX");
}));
add("B run bare leaf resolves dotted action", () => withRig(async (rig) => {
  const result = await call(rig, "/runs-names") as { slots: unknown };
  assert.deepEqual(result.slots, [{ id: "slot_09_11" }]);
}));
add("B run normalised camel name resolves dotted action", () => withRig(async (rig) => {
  const result = await call(rig, "/runs-names") as { byLeaf: number };
  assert.equal(result.byLeaf, 10);
}));
add("B call params reach the route", () => withRig(async (rig) => {
  const result = await rig.makeClient().call({
    url: `${rig.baseUrl}/echo-meta`, params: { q: "shoes", page: 2 }, data: null,
  }) as { params: Record<string, unknown> };
  assert.deepEqual(result.params, { q: "shoes", page: 2 });
}));
add("B call headers reach the route", () => withRig(async (rig) => {
  const result = await rig.makeClient().call({
    url: `${rig.baseUrl}/echo-meta`, headers: { "x-demo": "yes" }, data: null,
  }) as { demoHeader: string };
  assert.equal(result.demoHeader, "yes");
}));
add("B route receives request data untouched", () => withRig(async (rig) => {
  const result = await call(rig, "/echo-meta", { nested: { list: [1, 2, 3] } }) as { data: unknown };
  assert.deepEqual(result.data, { nested: { list: [1, 2, 3] } });
}));
add("B client service receives exact ask data", () => withRig(async (rig) => {
  let received: unknown;
  await call(rig, "/ask-mirror", { precise: true, level: 3 }, {
    mirror: async (data: any) => { received = data; return data; },
  });
  assert.deepEqual(received, { precise: true, level: 3 });
}));

// C. Batching asks()/runs() (12)
add("C asks run in one batch, order preserved", () => withRig(async (rig) => {
  const result = await call(rig, "/batch") as { profile: unknown; preferences: unknown };
  assert.deepEqual(result.profile, { name: "Alex", plan: "pro" });
  assert.deepEqual(result.preferences, { theme: "dark" });
}));
add("C runs execute in parallel with named access", () => withRig(async (rig) => {
  const result = await call(rig, "/batch") as { sum: number; product: number };
  assert.equal(result.sum, 5);
  assert.equal(result.product, 6);
}));
add("C asks results accessible by leaf and full name", () => withRig(async (rig) => {
  const result = await call(rig, "/asks-named") as { byLeaf: string; byFull: string; first: string };
  assert.equal(result.byLeaf, "Ghardaia-Centre");
  assert.equal(result.byFull, "Ghardaia-Centre");
  assert.equal(result.first, "Alex");
}));
add("C asks per-call fallback recovers a failing service", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/asks-fallback"), ["recovered", "Alex"]);
}));
add("C asks without fallback rejects on failing service", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/asks-no-fallback"), /service exploded/);
}));
add("C empty asks builder resolves to []", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/asks-empty"), []);
}));
add("C asks builder is awaitable without done()", () => withRig(async (rig) => {
  assert.equal(await call(rig, "/asks-awaitable"), "Alex");
}));
add("C asks builder is single-use", () => withRig(async (rig) => {
  assert.match(String(await call(rig, "/asks-double-done")), /only be called once/);
}));
add("C runs per-call fallback recovers a failing action", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/runs-fallback"), ["recovered", 2]);
}));
add("C runs without fallback rejects on failing action", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/runs-no-fallback"), /action exploded/);
}));
add("C single require() array honours descriptor fallback", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/single-fallback"), ["fb"]);
}));
add("C asks batch executes services in parallel (both called once)", () => withRig(async (rig) => {
  await call(rig, "/batch");
  assert.equal(rig.ctx.serviceCalls.getProfile, 1);
  assert.equal(rig.ctx.serviceCalls.getPreferences, 1);
}));

// D. External callbacks (8)
add("D callback completes the job with the provider payload", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/quote", { orderId: "ORD-1" }), {
    orderId: "ORD-1", quote: { quoteId: "Q-ORD-1", feeDzd: 750, etaMinutes: 85 },
  });
}));
add("D callback URL is captured by the action before it returns", () => withRig(async (rig) => {
  await call(rig, "/quote", { orderId: "ORD-2" });
  assert.equal(rig.ctx.capturedCallbackUrls.length, 1);
  assert.match(rig.ctx.capturedCallbackUrls[0]!, /__negotiation\/callback\?/);
}));
add("D wrong callback token gets 403, correct token still completes", () => withRig(async (rig) => {
  const pending = call(rig, "/quote", { orderId: "ORD-3" });
  while (rig.ctx.capturedCallbackUrls.length === 0) await sleep(5);
  const url = new URL(rig.ctx.capturedCallbackUrls[0]!);
  const wrong = new URL(url);
  wrong.searchParams.set("token", "wrong-token");
  const bad = await fetch(wrong, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 403);
  const good = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteId: "Q-MANUAL", feeDzd: 1, etaMinutes: 2 }),
  });
  assert.equal(good.status, 200);
  assert.deepEqual(await pending, { orderId: "ORD-3", quote: { quoteId: "Q-MANUAL", feeDzd: 1, etaMinutes: 2 } });
}));
add("D duplicate callback is acknowledged without changing the result", () => withRig(async (rig) => {
  const pending = call(rig, "/quote-slow", { orderId: "ORD-4" });
  while (rig.ctx.capturedCallbackUrls.length === 0) await sleep(5);
  const url = rig.ctx.capturedCallbackUrls[0]!;
  const post = (quoteId: string) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteId, feeDzd: 5, etaMinutes: 5 }),
  });
  const first = await post("Q-FIRST");
  assert.equal(first.status, 200);
  const dup = await post("Q-SECOND");
  assert.equal(dup.status, 200);
  assert.deepEqual(await dup.json(), { ok: true, duplicate: true });
  const result = await pending as { quote: { quoteId: string } };
  assert.equal(result.quote.quoteId, "Q-FIRST");
}));
add("D callback times out when the provider never calls back", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/quote-never"), /timed out/);
}, { requestTimeoutMs: 150 }));
add("D failing callback action fails the job", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/quote-fail"), /carrier down/);
}));
add("D createCallback with a function observes the payload", () => withRig(async (rig) => {
  const result = await call(rig, "/quote-fn") as { quoteId: string };
  assert.equal(result.quoteId, "Q-ORD-FN");
  assert.deepEqual(rig.ctx.callbackPayloads, [{ quoteId: "Q-ORD-FN", feeDzd: 750, etaMinutes: 85 }]);
}));
add("D two sequential callbacks in one job both resolve", () => withRig(async (rig) => {
  await call(rig, "/quote", { orderId: "ORD-5" });
  const second = await call(rig, "/quote", { orderId: "ORD-6" }) as { quote: { quoteId: string } };
  assert.equal(second.quote.quoteId, "Q-ORD-6");
  assert.equal(rig.ctx.capturedCallbackUrls.length, 2);
}));

// E. Client plugins (16)
add("E onRequest can add a header the server sees", () => withRig(async (rig) => {
  const client = rig.makeClient({}, [{ onRequest: (req) => { req.headers["x-demo"] = "from-plugin"; } }]);
  const result = await client.call({ url: `${rig.baseUrl}/echo-meta`, data: null }) as { demoHeader: string };
  assert.equal(result.demoHeader, "from-plugin");
}));
add("E onRequest can replace the request URL", () => withRig(async (rig) => {
  const client = rig.makeClient({}, [{
    onRequest: (req) => ({ ...req, url: req.url.replace("/nope", "/echo") }),
  }]);
  assert.deepEqual(await client.call({ url: `${rig.baseUrl}/nope`, data: { a: 1 } }), { a: 1 });
}));
add("E onRequest can mutate the body", () => withRig(async (rig) => {
  const client = rig.makeClient({}, [{
    onRequest: (req) => { req.body = { ...(req.body as object), data: { injected: true } }; },
  }]);
  assert.deepEqual(await client.call({ url: `${rig.baseUrl}/echo`, data: {} }), { injected: true });
}));
add("E onResponse can replace the final body result", () => withRig(async (rig) => {
  const client = rig.makeClient({}, [{
    onResponse: (body) => {
      const record = body as { done?: boolean; result?: unknown };
      if (record.done) return { ...record, result: { wrapped: record.result } };
      return undefined;
    },
  }]);
  assert.deepEqual(await client.call({ url: `${rig.baseUrl}/echo`, data: 7 }), { wrapped: 7 });
}));
add("E onResponse observes every round's status", () => withRig(async (rig) => {
  const statuses: number[] = [];
  const client = rig.makeClient({}, [{ onResponse: (_body, res) => { statuses.push(res.status); } }]);
  await client.call({ url: `${rig.baseUrl}/ask-two`, data: {} });
  assert.ok(statuses.length >= 3 && statuses.every((s) => s === 200));
}));
add("E onError fires on HTTP 404 (unknown route)", () => withRig(async (rig) => {
  const errors: string[] = [];
  const client = rig.makeClient({}, [{ onError: (e) => { errors.push(e.message); } }]);
  await assert.rejects(client.call({ url: `${rig.baseUrl}/missing`, data: {} }), /404/);
  assert.equal(errors.length, 1);
}));
add("E onError fires on connection refused", () => withRig(async (rig) => {
  const errors: string[] = [];
  const client = rig.makeClient({}, [{ onError: (e) => { errors.push(e.message); } }]);
  await assert.rejects(client.call({ url: "http://127.0.0.1:1/example", data: {} }));
  assert.equal(errors.length, 1);
}));
add("E returning false halts before fetch with REQUEST_HALTED", () => withRig(async (rig) => {
  const client = rig.makeClient({}, [{ onRequest: () => false }]);
  await assert.rejects(client.call({ url: `${rig.baseUrl}/echo`, data: {} }), (error: unknown) => {
    assert.ok(error instanceof RequestHaltedError);
    assert.equal((error as { code?: string }).code, "REQUEST_HALTED");
    return true;
  });
}));
add("E haltRequest halts with a custom message", () => withRig(async (rig) => {
  const guard: ClientPlugin = { onRequest: () => { haltRequest("not permitted"); } };
  const client = rig.makeClient({}, [guard]);
  await assert.rejects(client.call({ url: `${rig.baseUrl}/echo`, data: {} }), /not permitted/);
}));
add("E halted request never reaches the server", () => withRig(async (rig) => {
  let jobs = 0;
  rig.server.plugin({ onCallStart: () => { jobs += 1; } });
  const client = rig.makeClient({}, [{ onRequest: () => false }]);
  await assert.rejects(client.call({ url: `${rig.baseUrl}/echo`, data: {} }));
  assert.equal(jobs, 0);
}));
add("E thrown onRequest error is routed through onError", () => withRig(async (rig) => {
  const errors: string[] = [];
  const plugin: ClientPlugin = {
    onRequest: () => { throw new Error("plugin exploded"); },
    onError: (e) => { errors.push(e.message); },
  };
  const client = rig.makeClient({}, [plugin]);
  await assert.rejects(client.call({ url: `${rig.baseUrl}/echo`, data: {} }), /plugin exploded/);
  assert.deepEqual(errors, ["plugin exploded"]);
}));
add("E async hold preserves chain order (plug1 -> plug2 -> plug3)", () => withRig(async (rig) => {
  const order: string[] = [];
  const client = rig.makeClient({}, [
    { onRequest: async () => { order.push("p1:start"); await sleep(15); order.push("p1:end"); } },
    { onRequest: () => { order.push("p2"); } },
    { onRequest: () => { order.push("p3"); } },
  ]);
  await client.call({ url: `${rig.baseUrl}/echo`, data: {} });
  assert.deepEqual(order.slice(0, 4), ["p1:start", "p1:end", "p2", "p3"]);
}));
add("E plugins run on every round (initial + resumes)", () => withRig(async (rig) => {
  const phases: string[] = [];
  const client = rig.makeClient({}, [{ onRequest: (req) => { phases.push(req.phase); } }]);
  await client.call({ url: `${rig.baseUrl}/ask-two`, data: {} });
  assert.equal(phases[0], "initial");
  assert.ok(phases.length >= 3 && phases.slice(1).every((p) => p === "resume"));
}));
add("E phase-scoped plugin only touches the initial request", () => withRig(async (rig) => {
  let touched = 0;
  const plugin: ClientPlugin = {
    onRequest: (req) => { if (req.phase === "initial") { touched += 1; req.headers["x-demo"] = "init"; } },
  };
  const client = rig.makeClient({}, [plugin]);
  const result = await client.call({ url: `${rig.baseUrl}/echo-meta`, data: null }) as { demoHeader: string };
  assert.equal(touched, 1);
  assert.equal(result.demoHeader, "init");
}));
add("E a throwing onError masks the original and skips later plugins", () => withRig(async (rig) => {
  const seen: string[] = [];
  const client = rig.makeClient({}, [
    { onError: () => { seen.push("first"); throw new Error("mask"); } },
    { onError: () => { seen.push("second"); } },
  ]);
  await assert.rejects(client.call({ url: `${rig.baseUrl}/missing`, data: {} }), /mask/);
  assert.deepEqual(seen, ["first"]);
}));
add("E async onResponse delay does not change the result", () => withRig(async (rig) => {
  const client = rig.makeClient({}, [{ onResponse: async () => { await sleep(10); return undefined; } }]);
  assert.deepEqual(await client.call({ url: `${rig.baseUrl}/echo`, data: "ok" }), "ok");
}));

// F. Server plugins (12)
add("F onCallStart and onCallEnd fire around a successful job", () => withRig(async (rig) => {
  const events: string[] = [];
  rig.server.plugin({
    onCallStart: (job) => { events.push(`start:${job.path}`); },
    onCallEnd: (job) => { events.push(`end:${JSON.stringify(job.result)}`); },
  });
  await call(rig, "/echo", { x: 1 });
  assert.deepEqual(events, ["start:/echo", 'end:{"x":1}']);
}));
add("F onRound fires per round (no ask details exposed to plugins)", () => withRig(async (rig) => {
  const rounds: string[] = [];
  rig.server.plugin({ onRound: (r) => { rounds.push(`${r.round}:${"actions" in r}`); } });
  await call(rig, "/ask-two");
  assert.deepEqual(rounds, ["1:false", "2:false"]);
}));
add("F onCallError fires when the handler throws", () => withRig(async (rig) => {
  const errors: string[] = [];
  rig.server.plugin({ onCallError: (job) => { errors.push(job.error.message); } });
  await assert.rejects(call(rig, "/fail-handler"), /handler exploded/);
  assert.deepEqual(errors, ["handler exploded"]);
}));
add("F throwing onCallStart fails the job before the handler runs", () => withRig(async (rig) => {
  rig.server.plugin({ onCallStart: () => { throw new Error("job refused"); } });
  await assert.rejects(call(rig, "/echo", {}), /job refused/);
}));
add("F throwing onRound fails the job before the client service runs", () => withRig(async (rig) => {
  rig.server.plugin({ onRound: () => { throw new Error("round refused"); } });
  await assert.rejects(call(rig, "/ask-two"), /round refused/);
  assert.equal(rig.ctx.serviceCalls.getName ?? 0, 0);
}));
add("F throwing onCallEnd is reported via onError and result is unaffected", async () => {
  const reported: string[] = [];
  const server = new NegotiationServer({
    onError: (error, info) => { reported.push(`${info.phase}:${error.message}`); },
  });
  server.plugin({ onCallEnd: () => { throw new Error("observer exploded"); } });
  server.handle("/x", async () => ({ ok: true }));
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  try {
    const client = new NegotiationClient();
    assert.deepEqual(await client.call({ url: `http://127.0.0.1:${address.port}/x`, data: {} }), { ok: true });
    assert.deepEqual(reported, ["plugin:onCallEnd:observer exploded"]);
  } finally {
    await server.close();
  }
});
add("F throwing onCallError is reported and the original error reaches the client", async () => {
  const reported: string[] = [];
  const server = new NegotiationServer({
    onError: (error, info) => { reported.push(`${info.phase}:${error.message}`); },
  });
  server.plugin({ onCallError: () => { throw new Error("error-observer exploded"); } });
  server.handle("/x", async () => { throw new Error("handler exploded"); });
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  try {
    const client = new NegotiationClient();
    await assert.rejects(client.call({ url: `http://127.0.0.1:${address.port}/x`, data: {} }), /handler exploded/);
    assert.deepEqual(reported, ["plugin:onCallError:error-observer exploded"]);
  } finally {
    await server.close();
  }
});
add("F plugin array runs both plugins in registration order", () => withRig(async (rig) => {
  const order: string[] = [];
  const first: ServerPlugin = { name: "first", onCallStart: () => { order.push("first"); } };
  const second: ServerPlugin = { name: "second", onCallStart: () => { order.push("second"); } };
  rig.server.plugin([first, second]);
  await call(rig, "/echo", {});
  assert.deepEqual(order, ["first", "second"]);
}));
add("F plugin hook receives job metadata (path, method, round)", () => withRig(async (rig) => {
  const seen: Array<{ path: string; method: string; round: number }> = [];
  rig.server.plugin({ onCallStart: (job) => { seen.push({ path: job.path, method: job.method, round: job.round }); } });
  await call(rig, "/echo", {});
  assert.deepEqual(seen, [{ path: "/echo", method: "POST", round: 0 }]);
}));
add("F plugin() rejects a non-function hook", () => withRig(async (rig) => {
  assert.throws(() => rig.server.plugin({ onRound: "nope" } as never), TypeError);
}));
add("F plugin() rejects a non-object plugin", () => withRig(async (rig) => {
  assert.throws(() => rig.server.plugin(42 as never), TypeError);
}));
add("F plugin with only a name is accepted and harmless", () => withRig(async (rig) => {
  rig.server.plugin({ name: "noop" });
  assert.deepEqual(await call(rig, "/echo", "ok"), "ok");
}));

// G. Protocol, errors, concurrency (14)
add("G unknown route rejects with a 404 error", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/missing"), /404/);
}));
add("G handler error maps to INTERNAL_ERROR for plain Errors", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/fail-handler"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "INTERNAL_ERROR");
    return true;
  });
}));
add("G coded handler error preserves its code", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/fail-coded"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "TEAPOT");
    assert.match((error as Error).message, /teapot/);
    return true;
  });
}));
add("G unknown client service fails the job", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/unknown-service"), /no\.suchService|Unknown|not/i);
}));
add("G unknown server action fails the job", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/unknown-action"), /Unknown server action/);
}));
add("G failing client service without fallback surfaces its message", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/asks-no-fallback"), /service exploded/);
}));
add("G ten concurrent calls on one client all succeed", () => withRig(async (rig) => {
  const client = rig.makeClient();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => client.call({ url: `${rig.baseUrl}/greet`, data: { a: i, b: 1 } })),
  );
  results.forEach((result, i) => {
    assert.deepEqual(result, { name: "Alex", sum: i + 1 });
  });
}));
add("G one client can be reused for sequential calls", () => withRig(async (rig) => {
  const client = rig.makeClient();
  assert.deepEqual(await client.call({ url: `${rig.baseUrl}/echo`, data: 1 }), 1);
  assert.deepEqual(await client.call({ url: `${rig.baseUrl}/echo`, data: 2 }), 2);
  assert.deepEqual(await client.call({ url: `${rig.baseUrl}/echo`, data: 3 }), 3);
}));
add("G two clients operate independently", () => withRig(async (rig) => {
  const first = rig.makeClient({ getName: async () => "First" });
  const second = rig.makeClient({ getName: async () => "Second" });
  const [a, b] = await Promise.all([
    first.call({ url: `${rig.baseUrl}/greet`, data: { a: 1, b: 1 } }),
    second.call({ url: `${rig.baseUrl}/greet`, data: { a: 2, b: 2 } }),
  ]);
  assert.deepEqual(a, { name: "First", sum: 2 });
  assert.deepEqual(b, { name: "Second", sum: 4 });
}));
add("G job count returns to zero after completion", () => withRig(async (rig) => {
  await call(rig, "/greet", { a: 1, b: 2 });
  assert.equal(rig.server.getActiveCallCount(), 0);
}));
add("G exceeding maxRounds rejects with MAX_ROUNDS_EXCEEDED", () => withRig(async (rig) => {
  const client = rig.makeClient();
  await assert.rejects(client.call({ url: `${rig.baseUrl}/loop`, data: {}, maxRounds: 2 }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "MAX_ROUNDS_EXCEEDED");
    return true;
  });
}, { requestTimeoutMs: 1_000 }));
add("G slow client service triggers a server round timeout", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/slow-service"));
}, { requestTimeoutMs: 120 }));
add("G a job that errors still cleans up its job entry", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/fail-handler"));
  assert.equal(rig.server.getActiveCallCount(), 0);
}));
add("G server actions receive the request context (path via second arg)", () => withRig(async (rig) => {
  let seenPath: string | undefined;
  rig.server.use({
    "ctx.path": async (_data: unknown, request?: { path: string }) => {
      seenPath = request?.path;
      return seenPath;
    },
  });
  rig.server.handle("/ctx", async () => server2Path(rig));
  async function server2Path(r: Rig): Promise<unknown> {
    return r.server.run.ctx.path({});
  }
  assert.equal(await call(rig, "/ctx"), "/ctx");
  assert.equal(seenPath, "/ctx");
}));

// H. Rounds & lifecycle (10)
add("H explicit server.end(result) finishes the call", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/explicit-end"), { via: "end" });
}));
add("H server.respond + end() finishes with the stored result", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/respond-end"), { via: "respond" });
}));
add("H handler returning undefined yields a null result", () => withRig(async (rig) => {
  assert.equal(await call(rig, "/return-undefined"), null);
}));
add("H three sequential rounds resolve in order", () => withRig(async (rig) => {
  assert.deepEqual(await call(rig, "/ask-three"), { name: "Alex", city: "Graz", area: "Ghardaia-Centre" });
  assert.equal(rig.ctx.serviceCalls.getName, 1);
  assert.equal(rig.ctx.serviceCalls.getCity, 1);
}));
add("H batched asks are a single round carrying both actions", () => withRig(async (rig) => {
  const rounds: number[] = [];
  rig.server.plugin({ onRound: (r) => { rounds.push(r.round); } });
  await call(rig, "/batch");
  assert.deepEqual(rounds, [1]); // both asks travelled in ONE round
}));
add("H client constructor maxRounds option caps the call", () => withRig(async (rig) => {
  const client = new NegotiationClient({ maxRounds: 1 });
  client.use({ ...defaultServices(rig.ctx) });
  await assert.rejects(client.call({ url: `${rig.baseUrl}/ask-two`, data: {} }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "MAX_ROUNDS_EXCEEDED");
    return true;
  });
}));
add("H custom callback path is honoured by server.callback", () => withRig(async (rig) => {
  const result = await call(rig, "/quote-custom-path", { orderId: "ORD-7" }) as { quote: { quoteId: string } };
  assert.equal(result.quote.quoteId, "Q-ORD-7");
  assert.match(rig.ctx.capturedCallbackUrls[0]!, /\/hooks\/carrier\?/);
}));
add("H stateful server action persists across calls (shared registry)", () => withRig(async (rig) => {
  assert.equal(await call(rig, "/count"), 1);
  assert.equal(await call(rig, "/count"), 2);
  assert.equal(await call(rig, "/count"), 3);
}));
add("H job expiry rejects a waiting callback with JOB_EXPIRED", () => withRig(async (rig) => {
  await assert.rejects(call(rig, "/quote-never"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "JOB_EXPIRED");
    return true;
  });
}, { requestTimeoutMs: 5_000, jobTimeoutMs: 150 }));
add("H contract server rejects asking for a service outside the contract", async () => {
  const contract = defineContract({
    client: { getName: defineService<string>() },
    server: {},
  });
  const server = createServer(contract);
  // Deliberately ask outside the contract (cast: the type system rightly objects).
  server.handle("/x", async () => (server.ask as any).getCity());
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  try {
    const client = createClient(contract);
    client.provide({ getName: async () => "Alex" });
    await assert.rejects(
      client.call({ url: `http://127.0.0.1:${address.port}/x`, data: {} }),
      /not defined in the contract/,
    );
  } finally {
    await server.close();
  }
});

// I. Integration & misc (6)
add("I Express integration serves negotiations through requestHandler", async () => {
  const server = new NegotiationServer();
  server.handle("/example", async () => {
    const name = await server.ask.getName();
    return { name };
  });
  const app = express();
  app.use(express.json());
  app.use(server.requestHandler());
  const http: HttpServer = createHttpServer(app);
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  try {
    const client = new NegotiationClient();
    client.use({ getName: async () => "Alex" });
    assert.deepEqual(
      await client.call({ url: `http://127.0.0.1:${address.port}/example`, data: {} }),
      { name: "Alex" },
    );
  } finally {
    await server.close();
  }
});
add("I fallback handler can claim non-protocol paths", () => withRig(async (rig) => {
  rig.server.setPreHandler(async (req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    return false;
  });
  const response = await fetch(`${rig.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(await call(rig, "/echo", "still-works"), "still-works");
}));
add("I route matching ignores the query string", () => withRig(async (rig) => {
  const client = rig.makeClient();
  const result = await client.call({ url: `${rig.baseUrl}/echo?source=test`, data: "qs" });
  assert.equal(result, "qs");
}));
add("I contract-first createServer/createClient type the flow", async () => {
  const contract = defineContract({
    client: { getName: defineService<string>() },
    server: { "math.add": defineAction<number, { a: number; b: number }>() },
  });
  const server = createServer(contract);
  server.implement({ "math.add": async ({ a, b }) => a + b });
  server.handle("/example", async () => {
    const name = await server.ask.getName();
    const sum = await server.run.math.add({ a: 1, b: 2 });
    return { name, sum };
  });
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  try {
    const client = createClient(contract);
    client.provide({ getName: async () => "Alex" });
    assert.deepEqual(
      await client.call({ url: `http://127.0.0.1:${address.port}/example`, data: {} }),
      { name: "Alex", sum: 3 },
    );
  } finally {
    await server.close();
  }
});
add("I attach exposes httpServer and close clears it", () => withRig(async (rig) => {
  assert.ok(rig.server.httpServer);
  await rig.close();
  assert.equal(rig.server.httpServer, undefined);
}));
add("I after close, calls to the server fail at connection level", async () => {
  let baseUrl = "";
  await withRig(async (rig) => {
    baseUrl = rig.baseUrl;
    assert.deepEqual(await call(rig, "/echo", 1), 1);
  });
  const client = new NegotiationClient();
  await assert.rejects(client.call({ url: `${baseUrl}/echo`, data: {} }));
});

if (scenarios.length !== 100) {
  throw new Error(`Expected exactly 100 scenarios, built ${scenarios.length}`);
}

for (const scenario of scenarios) {
  test(scenario.name, scenario.run);
}
