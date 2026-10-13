import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  MemoryRequestStore,
  NegotiationClient,
  NegotiationServer,
} from "./protocol.js";

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("simplified negotiation API handles client services, fallbacks, server actions, and external callbacks", async () => {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const store = new MemoryRequestStore();
  const server = new NegotiationServer({ publicBaseUrl: baseUrl, store, requestTimeoutMs: 5_000 });

  server.use({
    "math.double": async ({ value }) => Number(value) * 2,
    "carrier.request": async ({ callbackUrl }) => {
      setTimeout(() => {
        void fetch(String(callbackUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ quoteId: "Q-1", price: 750 }),
        });
      }, 10);
      return { accepted: true };
    },
  });

  server.handle("/test", async () => {
    const [clientValue, fallbackValue] = await server.requireMany([
      { name: "getValue", data: {}, fallback: 0 },
      { name: "notRegistered", data: {}, fallback: "fallback-used" },
    ]);
    const doubled = await server.call<number>("math.double", { value: clientValue });
    const quote = await server.callback<{ quoteId: string; price: number }>("carrier.request", {});
    await server.end({ clientValue, fallbackValue, doubled, quote });
  });

  const client = new NegotiationClient();
  client.use({ getValue: async () => 21 });

  await server.listen(port, "127.0.0.1");
  try {
    const result = await client.call({ url: `${baseUrl}/test`, data: {} }) as {
      clientValue: number;
      fallbackValue: string;
      doubled: number;
      quote: { quoteId: string; price: number };
    };

    assert.deepEqual(result, {
      clientValue: 21,
      fallbackValue: "fallback-used",
      doubled: 42,
      quote: { quoteId: "Q-1", price: 750 },
    });
    assert.equal(store.records.size, 1);
  } finally {
    await server.close();
  }
});

async function postRaw(baseUrl: string, path: string, body: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: res.status, body: await res.json() as any };
}

async function postJson(baseUrl: string, path: string, data: unknown): Promise<{ status: number; body: any }> {
  return postRaw(baseUrl, path, JSON.stringify(data));
}

async function withServer(
  server: NegotiationServer,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  await server.listen(port, "127.0.0.1");
  try {
    await run(baseUrl);
  } finally {
    await server.close();
  }
}

test("rejects wrong method, unknown route, invalid JSON, invalid body and oversized body", async () => {
  const server = new NegotiationServer({ maxBodyBytes: 32 });
  server.handle("/ok", async () => server.end({ ok: true }));
  await withServer(server, async (baseUrl) => {
    const getRes = await fetch(`${baseUrl}/ok`);
    assert.equal(getRes.status, 405);

    const notFound = await postJson(baseUrl, "/nope", {});
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, "NOT_FOUND");

    const invalidJson = await postRaw(baseUrl, "/ok", "{not-json");
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.error.code, "INVALID_JSON");

    const invalidBody = await postRaw(baseUrl, "/ok", "[1,2,3]");
    assert.equal(invalidBody.status, 400);
    assert.equal(invalidBody.body.error.code, "INVALID_BODY");

    const tooLarge = await postJson(baseUrl, "/ok", { data: "x".repeat(100) });
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.body.error.code, "BODY_TOO_LARGE");
  });
});

test("resume requires a valid rotating token and a known job, and tokens are single-round", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000 });
  server.handle("/test", async () => {
    const value = await server.require<string>("getValue", {});
    const second = await server.require<string>("getValue", {});
    await server.end({ value, second });
  });
  await withServer(server, async (baseUrl) => {
    const unknown = await postJson(baseUrl, "/__negotiation/resume", {
      jobId: "missing", round: 1, resumeToken: "x", results: [],
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "UNKNOWN_JOB");

    const initial = await postJson(baseUrl, "/test", { data: {} });
    assert.equal(initial.body.done, false);
    const { jobId, round, resumeToken } = initial.body;

    const wrong = await postJson(baseUrl, "/__negotiation/resume", {
      jobId, round, resumeToken: "wrong-token",
      results: [{ callbackID: initial.body.actions[0].callbackID, ok: true, result: "hello" }],
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, "INVALID_RESUME_TOKEN");

    const resumed = await postJson(baseUrl, "/__negotiation/resume", {
      jobId, round, resumeToken,
      results: [{ callbackID: initial.body.actions[0].callbackID, ok: true, result: "hello" }],
    });
    // Second round must carry a different (rotated) token.
    assert.equal(resumed.body.done, false);
    assert.notEqual(resumed.body.resumeToken, resumeToken);

    // Re-using the first token must now fail.
    const reused = await postJson(baseUrl, "/__negotiation/resume", {
      jobId, round: resumed.body.round, resumeToken,
      results: [{ callbackID: resumed.body.actions[0].callbackID, ok: true, result: "again" }],
    });
    assert.equal(reused.status, 403);

    const final = await postJson(baseUrl, "/__negotiation/resume", {
      jobId, round: resumed.body.round, resumeToken: resumed.body.resumeToken,
      results: [{ callbackID: resumed.body.actions[0].callbackID, ok: true, result: "world" }],
    });
    assert.equal(final.body.done, true);
    assert.deepEqual(final.body.result, { value: "hello", second: "world" });
  });
});

test("unknown client service without fallback surfaces as a thrown error", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000 });
  server.handle("/test", async () => {
    const value = await server.require("missingService", {});
    await server.end({ value });
  });
  const client = new NegotiationClient();
  await withServer(server, async (baseUrl) => {
    await assert.rejects(
      client.call({ url: `${baseUrl}/test`, data: {} }),
      (error: any) => error?.code === "SERVICE_NOT_FOUND",
    );
  });
});

test("sensitive headers are redacted before persistence", async () => {
  const store = new MemoryRequestStore();
  const server = new NegotiationServer({ store });
  server.handle("/test", async () => server.end({ ok: true }));
  const client = new NegotiationClient();
  await withServer(server, async (baseUrl) => {
    await client.call({
      url: `${baseUrl}/test`,
      data: {},
      headers: { authorization: "Bearer super-secret", cookie: "session=abc", "x-trace-id": "trace-1" },
    });
    const [record] = [...store.records.values()];
    assert.equal(record?.request.headers.authorization, "[REDACTED]");
    assert.equal(record?.request.headers.cookie, "[REDACTED]");
    assert.equal(record?.request.headers["x-trace-id"], "trace-1");
    assert.equal(JSON.stringify(record).includes("super-secret"), false);
  });
});

test("client aborts after maxRounds instead of looping forever", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000 });
  server.handle("/test", async () => {
    await server.require("getValue", {});
    await server.require("getValue", {});
    await server.end({ ok: true });
  });
  const client = new NegotiationClient({ maxRounds: 1 });
  client.use({ getValue: async () => 1 });
  await withServer(server, async (baseUrl) => {
    await assert.rejects(
      client.call({ url: `${baseUrl}/test`, data: {} }),
      (error: any) => error?.code === "MAX_ROUNDS_EXCEEDED",
    );
  });
});

test("abandoned jobs expire and can no longer be resumed", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000, jobTimeoutMs: 100 });
  server.handle("/test", async () => {
    const value = await server.require("getValue", {});
    await server.end({ value });
  });
  await withServer(server, async (baseUrl) => {
    const initial = await postJson(baseUrl, "/test", { data: {} });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const resumed = await postJson(baseUrl, "/__negotiation/resume", {
      jobId: initial.body.jobId, round: initial.body.round, resumeToken: initial.body.resumeToken,
      results: [{ callbackID: initial.body.actions[0].callbackID, ok: true, result: 1 }],
    });
    assert.equal(resumed.status, 404);
    assert.equal(server.getJobCount(), 0);
  });
});

test("duplicate external callbacks are acknowledged without settling twice", async () => {
  let callbackUrl = "";
  const server = new NegotiationServer({ requestTimeoutMs: 5_000 });
  server.use({
    "carrier.request": async ({ callbackUrl: url }: any) => {
      callbackUrl = String(url);
      return { accepted: true };
    },
  });
  server.handle("/test", async () => {
    const quote = await server.callback("carrier.request", {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    await server.end({ quote });
  });
  const client = new NegotiationClient();
  await withServer(server, async (baseUrl) => {
    const callPromise = client.call({ url: `${baseUrl}/test`, data: {} });
    for (let i = 0; i < 50 && !callbackUrl; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(callbackUrl, "server action should have received a callbackUrl");
    const first = await postRaw(baseUrl, new URL(callbackUrl).pathname + new URL(callbackUrl).search, JSON.stringify({ price: 10 }));
    assert.deepEqual(first.body, { ok: true, received: true });
    const duplicate = await postRaw(baseUrl, new URL(callbackUrl).pathname + new URL(callbackUrl).search, JSON.stringify({ price: 10 }));
    assert.deepEqual(duplicate.body, { ok: true, duplicate: true });
    assert.deepEqual(await callPromise, { quote: { price: 10 } });
  });
});

test("MemoryRequestStore evicts oldest entries beyond its bound", async () => {
  const store = new MemoryRequestStore(2);
  const entry = (jobId: string) => ({
    jobId,
    request: { jobId, method: "POST", path: "/x", origin: "http://x", params: {}, data: null, headers: {} },
    response: { protocol: 1 as const, jobId, round: 0, done: true, actions: [] },
    createdAt: new Date().toISOString(),
  });
  await store.save(entry("a"));
  await store.save(entry("b"));
  await store.save(entry("c"));
  assert.equal(store.records.size, 2);
  assert.equal(store.records.has("a"), false);
  assert.equal(store.records.has("c"), true);
});

test("v1.3 magic proxy syntax: server.ask.* and server.run.* replace string names", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000 });
  server.use({
    "math.add": async ({ a, b }: any) => Number(a) + Number(b),
    "delivery.getAvailableSlots": async () => ["slot_1", "slot_2"],
  });
  server.handle("/test", async () => {
    const name: string = await server.ask.getName();
    const area: string = await server.ask.location.getArea({ precise: false });
    const sum: number = await server.run.math.add({ a: 2, b: 3 });
    const sumFuzzy: number = await server.run.mathAdd({ a: 1, b: 1 });
    const slots: string[] = await server.run.getAvailableSlots({});
    const slotsNested: string[] = await server.run.delivery.getAvailableSlots({});
    return { name, area, sum, sumFuzzy, slots, slotsNested };
  });
  const client = new NegotiationClient();
  client.use({
    getName: async () => "Alex",
    "location.getArea": async () => "Ghardaia-Centre",
  });
  await withServer(server, async (baseUrl) => {
    const result = await client.call({ url: `${baseUrl}/test`, data: {} });
    assert.deepEqual(result, {
      name: "Alex",
      area: "Ghardaia-Centre",
      sum: 5,
      sumFuzzy: 2,
      slots: ["slot_1", "slot_2"],
      slotsNested: ["slot_1", "slot_2"],
    });
  });
});

test("magic proxy surfaces unknown and ambiguous action errors", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000 });
  server.use({
    "a.get": async () => 1,
    "b.get": async () => 2,
  });
  server.handle("/unknown", async () => server.run.nope());
  server.handle("/ambiguous", async () => server.run.get());
  const client = new NegotiationClient();
  await withServer(server, async (baseUrl) => {
    await assert.rejects(client.call({ url: `${baseUrl}/unknown`, data: {} }), /Unknown server action/);
    await assert.rejects(client.call({ url: `${baseUrl}/ambiguous`, data: {} }), /Ambiguous server action/);
  });
});

test("v1.4 asks() builder batches chained services into one round via done()", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000 });
  server.handle("/test", async (request) => {
    const input = request.data as { orderId: string };
    // Exactly the proposed syntax (plus named/index access on the result):
    const asks = server.asks();
    asks.selectDeliverySlot({
      orderId: input.orderId,
      slots: ["slot_1", "slot_2"],
      fragileHandling: true,
    }).getNames();
    const results = await asks.done();
    return {
      byIndex: [results[0], results[1]],
      byName: results.selectDeliverySlot,
      names: results.getNames,
    };
  });
  server.handle("/fallbacks", async () => {
    const asks = server.asks();
    asks.location.getArea().notRegistered({}, { fallback: "fallback-used" }).getNames();
    const results = await asks.done();
    const awaited = await server.asks().getNames(); // builder is also awaitable
    return {
      area: results.getArea,
      areaByFullName: results["location.getArea"],
      missing: results[1],
      awaited,
    };
  });
  const client = new NegotiationClient();
  client.use({
    selectDeliverySlot: async ({ slots }: any) => ({ slotId: slots[1] }),
    getNames: async () => ["a", "b"],
    "location.getArea": async () => "Ghardaia-Centre",
  });
  await withServer(server, async (baseUrl) => {
    assert.deepEqual(await client.call({ url: `${baseUrl}/test`, data: { orderId: "ORD-1" } }), {
      byIndex: [{ slotId: "slot_2" }, ["a", "b"]],
      byName: { slotId: "slot_2" },
      names: ["a", "b"],
    });
    assert.deepEqual(await client.call({ url: `${baseUrl}/fallbacks`, data: {} }), {
      area: "Ghardaia-Centre",
      areaByFullName: "Ghardaia-Centre",
      missing: "fallback-used",
      awaited: [["a", "b"]],
    });
  });
});

test("asks() builder is single-use", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000 });
  server.handle("/test", async () => {
    const asks = server.asks();
    asks.getNames();
    await asks.done();
    await asks.done(); // second call must throw
    return { unreachable: true };
  });
  const client = new NegotiationClient();
  client.use({ getNames: async () => [] });
  await withServer(server, async (baseUrl) => {
    await assert.rejects(
      client.call({ url: `${baseUrl}/test`, data: {} }),
      /asks\.done\(\) can only be called once/,
    );
  });
});
