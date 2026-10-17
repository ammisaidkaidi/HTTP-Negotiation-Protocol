import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import { NegotiationClient } from "../src/client/index.js";
import {
  handledResult,
  NegotiationServer,
  type ServerPlugin,
} from "../src/server/index.js";

async function withServer(
  server: NegotiationServer,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test server");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await server.close();
  }
}

function recorder(events: string[]): ServerPlugin {
  return {
    name: "recorder",
    onCallStart: (job) => {
      events.push(`start:${job.path}:round${job.round}`);
    },
    onRound: (round) => {
      events.push(`round${round.round}`);
    },
    onCallEnd: (job) => {
      events.push(`end:${JSON.stringify(job.result)}`);
    },
    onCallError: (job) => {
      events.push(`error:${job.error.message}`);
    },
  };
}

test("server plugins observe start, every round, and successful end in order", async () => {
  const events: string[] = [];
  const server = new NegotiationServer();
  server.plugin(recorder(events));
  server.handle("/example", async () => {
    const name = await server.ask.getName();
    const city = await server.ask.getCity();
    return { name, city };
  });

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    client.use({
      getName: async () => "Alex",
      getCity: async () => "Graz",
    });
    const result = await client.call({ url: `${baseUrl}/example`, data: {} });
    assert.deepEqual(result, { name: "Alex", city: "Graz" });
  });

  assert.deepEqual(events, [
    "start:/example:round0",
    "round1",
    "round2",
    'end:{"name":"Alex","city":"Graz"}',
  ]);
});

test("server plugins accept an array and onCallError observes handler failures", async () => {
  const events: string[] = [];
  const server = new NegotiationServer();
  server.plugin([recorder(events), { name: "noop" }]);
  server.handle("/boom", async () => {
    throw new Error("boom");
  });

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    await assert.rejects(client.call({ url: `${baseUrl}/boom`, data: {} }), (error: unknown) => (error as { code?: string }).code === "INTERNAL_ERROR");
  });

  assert.deepEqual(events, ["start:/boom:round0", "error:boom"]);
});

test("a throwing onCallStart fails the job and still fires onCallError", async () => {
  const events: string[] = [];
  const server = new NegotiationServer();
  server.plugin({
    onCallStart: () => {
      throw new Error("plugin refused the job");
    },
    onCallError: (job) => {
      events.push(`error:${job.error.message}`);
    },
  });
  server.handle("/example", async () => ({ ok: true }));

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    await assert.rejects(
      client.call({ url: `${baseUrl}/example`, data: {} }),
      (error: unknown) => (error as { code?: string }).code === "INTERNAL_ERROR",
    );
  });

  assert.deepEqual(events, ["error:plugin refused the job"]);
});

test("a throwing onCallEnd is reported via onError and never changes the result", async () => {
  const reported: string[] = [];
  const server = new NegotiationServer({
    onError: (error, info) => reported.push(`${info.phase}:${error.message}`),
  });
  server.plugin({
    onCallEnd: () => {
      throw new Error("observer exploded");
    },
  });
  server.handle("/example", async () => ({ ok: true }));

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    const result = await client.call({ url: `${baseUrl}/example`, data: {} });
    assert.deepEqual(result, { ok: true });
  });

  assert.deepEqual(reported, ["plugin:onCallEnd:observer exploded"]);
});

test("onCallStart returning handledResult answers the job and skips next plugins + handler", async () => {
  const events: string[] = [];
  let handlerRan = false;
  const server = new NegotiationServer();
  server.plugin([
    {
      name: "cache",
      onCallStart: () => handledResult({ from: "plugin-cache" }),
    },
    {
      name: "later",
      onCallStart: () => { events.push("later:start"); },
      onCallEnd: (job) => { events.push(`later:end:${JSON.stringify(job.result)}`); },
    },
  ]);
  server.handle("/example", async () => {
    handlerRan = true;
    return { from: "handler" };
  });

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    const result = await client.call({ url: `${baseUrl}/example`, data: {} });
    assert.deepEqual(result, { from: "plugin-cache" });
  });

  assert.equal(handlerRan, false); // route handler skipped
  assert.deepEqual(events, ['later:end:{"from":"plugin-cache"}']); // later onCallStart skipped, onCallEnd still fires
});

test("async onCallStart can short-circuit, and handledResult() without a value yields undefined", async () => {
  const server = new NegotiationServer();
  server.plugin({
    onCallStart: async (job) => {
      if (job.path === "/empty") return handledResult();
      return handledResult({ path: job.path });
    },
  });
  server.handle("/empty", async () => ({ from: "handler" }));
  server.handle("/other", async () => ({ from: "handler" }));

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    assert.equal(await client.call({ url: `${baseUrl}/empty`, data: {} }), undefined);
    assert.deepEqual(await client.call({ url: `${baseUrl}/other`, data: {} }), { path: "/other" });
  });
});

test("deprecated onJob* aliases still work (start short-circuit, end, error)", async () => {
  const events: string[] = [];
  const server = new NegotiationServer();
  server.plugin({
    // Legacy names from v1.11.0 — must keep working.
    onJobStart: (job) => {
      events.push(`legacy-start:${job.path}`);
      if (job.path === "/cached") return handledResult({ legacy: true });
      return undefined;
    },
    onJobEnd: () => { events.push("legacy-end"); },
    onJobError: () => { events.push("legacy-error"); },
  });
  server.handle("/cached", async () => ({ from: "handler" }));
  server.handle("/fail", async () => { throw new Error("legacy boom"); });

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    assert.deepEqual(await client.call({ url: `${baseUrl}/cached`, data: {} }), { legacy: true });
    await assert.rejects(client.call({ url: `${baseUrl}/fail`, data: {} }), (error: unknown) => (error as { code?: string }).code === "INTERNAL_ERROR");
  });

  assert.deepEqual(events, [
    "legacy-start:/cached", "legacy-end",
    "legacy-start:/fail", "legacy-error",
  ]);
});

test("deprecated onNegotiation* aliases still work", async () => {
  const events: string[] = [];
  const server = new NegotiationServer();
  server.plugin({
    onNegotiationStart: () => { events.push("neg-start"); },
    onNegotiationEnd: () => { events.push("neg-end"); },
    onNegotiationError: () => { events.push("neg-error"); },
  });
  server.handle("/ok", async () => ({ ok: true }));
  server.handle("/fail", async () => { throw new Error("neg boom"); });

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    await client.call({ url: `${baseUrl}/ok`, data: {} });
    await assert.rejects(client.call({ url: `${baseUrl}/fail`, data: {} }), (error: unknown) => (error as { code?: string }).code === "INTERNAL_ERROR");
  });

  assert.deepEqual(events, ["neg-start", "neg-end", "neg-start", "neg-error"]);
});

test("callbackTimeoutMs times out external callbacks independently of requestTimeoutMs", async () => {
  const server = new NegotiationServer({ requestTimeoutMs: 5_000, callbackTimeoutMs: 120 });
  server.use({ "carrier.never": async () => ({ accepted: true }) });
  server.handle("/quote", async () => server.callback("carrier.never", { orderId: "X" }));

  const started = Date.now();
  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    await assert.rejects(client.call({ url: `${baseUrl}/quote`, data: {} }), /timed out/);
  });
  assert.ok(Date.now() - started < 3_000, "callback timeout fired near 120ms, not the 5s round timeout");
});

test("requestService matches require() for string and array forms", async () => {
  const server = new NegotiationServer();
  server.handle("/example", async () => {
    const name = await server.requestService<string>("getName");
    const [fallback] = await server.requestService([{ name: "explode", fallback: "fb" }]);
    return { name, fallback };
  });

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    client.use({
      getName: async () => "Alex",
      explode: async () => { throw new Error("boom"); },
    });
    assert.deepEqual(await client.call({ url: `${baseUrl}/example`, data: {} }), {
      name: "Alex", fallback: "fb",
    });
  });
});

test("deprecated aliases getJobCount/setFallbackHandler still work", async () => {
  const server = new NegotiationServer();
  server.setFallbackHandler(async (req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.end("ok");
      return true;
    }
    return false;
  });
  server.handle("/example", async () => ({ ok: true }));

  await withServer(server, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(server.getJobCount(), 0);
    assert.equal(server.getActiveCallCount(), 0);
  });
});

test("plugin() validates its input", () => {
  const server = new NegotiationServer();
  assert.throws(() => server.plugin({ onRound: "nope" } as never), TypeError);
  assert.throws(() => server.plugin(42 as never), TypeError);
});
