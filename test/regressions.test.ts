import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, NegotiationClient } from "../src/client/index.js";
import { defineContract, svc, type ClientAction } from "../src/common/negotiations.js";
import { createServer, NegotiationServer } from "../src/server/index.js";

// Each test below reproduces one defect found in the src/ review and guards
// against it coming back.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

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

/** POST to baseUrl+path with an explicit Host header, as an attacker would send it. */
function postWithHost(baseUrl: string, path: string, host: string): Promise<void> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", host },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

// ---------------------------------------------------------------------------
// 1. randomInt hangs for ranges above 2^31 (32-bit bitwise ops in mask/value).
//    Run in a child process with a timeout, because a synchronous infinite
//    loop would otherwise block the whole test runner.
// ---------------------------------------------------------------------------
test("regression: randomInt returns in-range values for ranges above 2^31", () => {
  const script = [
    'import { randomInt } from "./src/common/webCrypto.ts";',
    "const max = 2 ** 31 + 10;",
    "const value = randomInt(0, max);",
    'if (!(value >= 0 && value < max)) throw new Error(`out of range: ${value}`);',
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: repoRoot, encoding: "utf8", timeout: 5_000 },
  );
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  assert.notEqual(spawnError?.code, "ETIMEDOUT", "randomInt did not return within 5s");
  assert.equal(result.status, 0, result.stderr);
});

// ---------------------------------------------------------------------------
// 2. server.run.<a>.<b> breaks when a segment matches a Function property
//    (name, length, call, apply, bind, ...) because createPathProxy uses
//    `prop in target` on a function target.
// ---------------------------------------------------------------------------
test("regression: server.run resolves action names that match Function properties", async () => {
  const server = new NegotiationServer();
  server.use({
    "customer.name": async ({ id }: { id: number }) => `hello ${id}`,
    "customer.length": async () => 42,
  });
  assert.equal(await server.run.customer.name({ id: 1 }), "hello 1");
  assert.equal(await server.run.customer.length(), 42);
});

// ---------------------------------------------------------------------------
// 3. With no publicBaseUrl, callbackUrl (sent to external services) takes its
//    host from the attacker-controllable Host request header.
// ---------------------------------------------------------------------------
test("regression: callback URLs do not take their host from the request Host header", async () => {
  const server = new NegotiationServer({ callbackTimeoutMs: 50 });
  let callbackUrl: string | undefined;
  let callbackError: Error | undefined;
  server.use({
    "hooks.waitFor": async (data: { callbackUrl: string }) => {
      callbackUrl = data.callbackUrl;
      return "scheduled";
    },
  });
  server.handle("/job", async () =>
    server.callback("hooks.waitFor", {}).catch((error: Error) => {
      callbackError = error;
      return "rejected";
    }));

  await withServer(server, async (baseUrl) => {
    await postWithHost(baseUrl, "/job", "attacker.example");
  });

  // The server refuses to build a callback for a foreign host, so the action
  // never receives an attacker-chosen URL.
  assert.equal(callbackUrl, undefined);
  assert.match(callbackError?.message ?? "", /publicBaseUrl/);
});

test("regression: publicBaseUrl is used for callback URLs regardless of the Host header", async () => {
  const server = new NegotiationServer({
    publicBaseUrl: "https://hooks.example.com",
    callbackTimeoutMs: 50,
  });
  let callbackUrl: string | undefined;
  server.use({
    "hooks.waitFor": async (data: { callbackUrl: string }) => {
      callbackUrl = data.callbackUrl;
      return "scheduled";
    },
  });
  server.handle("/job", async () => server.callback("hooks.waitFor", {}).catch(() => "timed out"));

  await withServer(server, async (baseUrl) => {
    await postWithHost(baseUrl, "/job", "attacker.example");
  });

  assert.ok(callbackUrl, "the action should have received a callbackUrl");
  assert.equal(new URL(callbackUrl).origin, "https://hooks.example.com");
});

// ---------------------------------------------------------------------------
// 4. A plugin onRound that throws leaves context.pending set, so the next
//    round in the same job fails with "already has a pending negotiation round".
// ---------------------------------------------------------------------------
test("regression: a throwing onRound does not leave a stale pending round for the next round", async () => {
  const server = new NegotiationServer();
  let refuseFirstRound = true;
  server.plugin({
    onRound: () => {
      if (refuseFirstRound) {
        refuseFirstRound = false;
        throw new Error("audit sink down");
      }
    },
  });
  server.handle("/job", async () => {
    try {
      await server.require("ping");
    } catch {
      // The first round was refused by the plugin; retry the same service.
    }
    return await server.require<string>("ping");
  });

  const client = new NegotiationClient();
  client.provide({ ping: async () => "pong" });

  await withServer(server, async (baseUrl) => {
    assert.equal(await client.call({ url: `${baseUrl}/job` }), "pong");
  });
});

// ---------------------------------------------------------------------------
// 5. provide() forwards to use(), which treats any map containing an
//    onRequest/onResponse/onError key as a plugin, so a service with one of
//    those names is silently never registered.
// ---------------------------------------------------------------------------
test("regression: client services named onError are registered, not mistaken for plugins", async () => {
  const server = new NegotiationServer();
  server.handle("/job", async () => await server.require<string>("onError"));

  const client = new NegotiationClient();
  client.provide({ onError: async () => "handled" });

  await withServer(server, async (baseUrl) => {
    assert.equal(await client.call({ url: `${baseUrl}/job` }), "handled");
  });
});

// ---------------------------------------------------------------------------
// 6. executeAction added an abort listener per action and never removed it,
//    so a long-lived signal accumulated one listener per service call.
// ---------------------------------------------------------------------------
test("regression: executeAction does not accumulate abort listeners on a shared signal", async () => {
  const client = new NegotiationClient();
  client.provide({
    ping: async () => "pong",
    slow: () => new Promise((resolve) => setTimeout(() => resolve("late"), 1_000)),
  });
  const execute = (client as unknown as {
    executeAction: (action: ClientAction, signal?: AbortSignal) => Promise<{ ok: boolean; error?: { code: string } }>;
  }).executeAction.bind(client);

  const controller = new AbortController();
  for (let index = 0; index < 50; index += 1) {
    const result = await execute({ name: "ping", data: null, callbackID: `cb_${index}` }, controller.signal);
    assert.equal(result.ok, true);
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  // Cancellation must still work: aborting settles the in-flight action as ABORTED.
  const pending = execute({ name: "slow", data: null, callbackID: "cb_slow" }, controller.signal);
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error?.code, "ABORTED");
});

// ---------------------------------------------------------------------------
// 7. maxResponseBytes was only checked after the entire body was buffered, so
//    an oversized response was read in full before being rejected.
// ---------------------------------------------------------------------------
test("regression: maxResponseBytes stops reading as soon as the limit is exceeded", async () => {
  const chunk = Buffer.alloc(64 * 1024, "x");
  const totalChunks = 1_000; // 64 MB, far above the 1 MB limit
  let chunksWritten = 0;
  let serving: Promise<void> | undefined;

  const http = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const drainOrClose = () =>
      new Promise<void>((resolve) => {
        res.once("drain", resolve);
        res.once("close", resolve);
      });
    serving = (async () => {
      for (let index = 0; index < totalChunks && !res.destroyed; index += 1) {
        chunksWritten += 1;
        if (!res.write(chunk)) await drainOrClose();
      }
      res.end();
    })();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  const client = new NegotiationClient({ maxResponseBytes: 1_000_000 });
  try {
    await assert.rejects(
      client.call({ url: `http://127.0.0.1:${port}/huge` }),
      (error: unknown) => (error as { code?: string }).code === "RESPONSE_TOO_LARGE",
    );
    await serving;
  } finally {
    http.closeAllConnections();
    http.close();
  }
  assert.ok(
    chunksWritten < totalChunks,
    `client read the whole ${(totalChunks * chunk.length) / 1_048_576} MB body (${chunksWritten} chunks written)`,
  );
});

// ---------------------------------------------------------------------------
// 8. Named aliases in batch results were written straight onto the results
//    array, so an action whose leaf name is `length` overwrote the array length.
// ---------------------------------------------------------------------------
test("regression: named aliases in runs() results never overwrite the array length", async () => {
  const server = new NegotiationServer();
  server.use({
    "stats.length": async () => 3,
    "stats.total": async () => 5,
  });
  const runs = server.runs();
  // Bracket access keeps this test on the results-array collision alone; the
  // proxy handling of `.length` is covered by the server.run test above.
  runs["stats.length"]();
  runs.stats.total();
  const results = await runs.done();

  assert.equal(results.length, 2);
  assert.deepEqual([...results], [3, 5]);
  assert.equal(results["stats.length"], 3);
  assert.equal(results.total, 5);
});

// ---------------------------------------------------------------------------
// 9. A client that disconnected left its job registered forever: end() cleared
//    the expiry timer and then threw on the closed response, so cleanup never ran.
// ---------------------------------------------------------------------------
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("regression: a job whose client disconnected is removed once it completes", async () => {
  const server = new NegotiationServer({ callbackTimeoutMs: 5_000 });
  let callbackUrl = "";
  server.use({
    "hooks.wait": async (data: { callbackUrl: string }) => {
      callbackUrl = data.callbackUrl;
      return "scheduled";
    },
  });
  server.handle("/job", async () => server.callback("hooks.wait", {}));
  const http = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  // Start the job, then drop the client while the job waits for its callback.
  await new Promise<void>((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/job", method: "POST", headers: { "content-type": "application/json" } },
      () => undefined,
    );
    req.on("error", () => undefined);
    req.end("{}");
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 150);
  });

  try {
    const callback = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(callback.status, 200);
    await pause(100);
    assert.equal(server.getActiveCallCount(), 0);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 10. A plugin returning the body it was given replaced the real envelope with
//     the redacted copy (actions: []), so the client never ran its services.
// ---------------------------------------------------------------------------
test("regression: a plugin that returns the body it was given does not break the call", async () => {
  const server = new NegotiationServer();
  server.handle("/job", async () => await server.require<string>("ping"));
  const http = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  const client = new NegotiationClient();
  client.provide({ ping: async () => "pong" });
  client.use({ onResponse: (body: unknown) => body });
  try {
    assert.equal(await client.call({ url: `http://127.0.0.1:${port}/job` }), "pong");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 11. Server shutdown rejected the handler but never answered the waiting
//     client, so the client only failed when its own request timeout fired.
// ---------------------------------------------------------------------------
test("regression: server shutdown delivers SERVER_SHUTDOWN to a waiting client promptly", async () => {
  const server = new NegotiationServer({ callbackTimeoutMs: 60_000 });
  server.use({ "hooks.never": async () => new Promise(() => undefined) });
  server.handle("/job", async () => server.callback("hooks.never", {}));
  const http = createHttpServer(server.requestHandler());
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  const client = new NegotiationClient({ requestTimeoutMs: 5_000 });
  const started = Date.now();
  const outcome = client.call({ url: `http://127.0.0.1:${port}/job` }).then(
    () => "resolved",
    (error: Error & { code?: string }) => error.code ?? error.name,
  );
  await pause(100);
  try {
    await server.close();
    assert.equal(await outcome, "SERVER_SHUTDOWN");
    assert.ok(Date.now() - started < 4_000, "the client waited for its own timeout instead");
  } finally {
    http.closeAllConnections();
    http.close();
  }
});

// ---------------------------------------------------------------------------
// 12. Batch results were matched to actions by position. A client that returns
//     results in a different order got each result paired with the wrong action.
// ---------------------------------------------------------------------------
test("regression: batch results are matched to actions by callbackID, not by position", async () => {
  const server = new NegotiationServer();
  server.handle("/job", async () => await server.require([{ name: "svc.a" }, { name: "svc.b" }]));
  const http = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((response) => response.json() as Promise<any>);

  try {
    const first = await post(`${base}/job`, {});
    const results = [...first.actions].reverse().map((action: ClientAction) => ({
      callbackID: action.callbackID,
      ok: true,
      result: action.name.toUpperCase(),
    }));
    const final = await post(`${base}${first.resumeUrl}`, {
      jobId: first.jobId,
      round: first.round,
      resumeToken: first.resumeToken,
      results,
    });
    assert.deepEqual(final.result, ["SVC.A", "SVC.B"]);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 13. Contract checks used `in`, which also matches Object.prototype names, so
//     `constructor` and `toString` passed as if they were declared in the contract.
// ---------------------------------------------------------------------------
test("regression: contract checks reject prototype names such as constructor", async () => {
  const contract = defineContract({ client: { getName: svc<string>() }, server: {} });
  const server = createServer(contract);
  server.handle("/job", async () => await (server.ask as any).constructor());
  const http = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  const client = createClient(contract);
  try {
    await assert.rejects(client.call({ url: `http://127.0.0.1:${port}/job` }), /not defined in the contract/);
  } finally {
    await server.close();
  }
  assert.throws(() => createClient(contract).provide({ constructor: async () => "x" } as never), TypeError);
});

// ---------------------------------------------------------------------------
// 14. use() accepted a plugin whose hook was not a function, and failed later
//     with an unclear error. The server's plugin() already validates hooks.
// ---------------------------------------------------------------------------
test("regression: use() rejects a plugin whose hook is not a function", () => {
  const client = new NegotiationClient();
  assert.throws(() => client.use({ onRequest: "nope" } as never), TypeError);
});

// ---------------------------------------------------------------------------
// 15. maxJobs was checked before the request body was read and before the job
//     was registered, with awaits in between. Requests with slow bodies all
//     passed the check together, so the limit was overshot.
// ---------------------------------------------------------------------------
test("regression: maxJobs holds even when many requests arrive with slow bodies", async () => {
  const server = new NegotiationServer({ maxJobs: 2, callbackTimeoutMs: 60_000 });
  let peak = 0;
  server.use({ "hooks.never": async () => new Promise(() => undefined) });
  server.handle("/job", async () => {
    peak = Math.max(peak, server.getActiveCallCount());
    return await server.callback("hooks.never", {});
  });
  const http = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  // Send every request's headers first and hold the body back, so all of them
  // are in flight before any job is registered.
  const requests: Array<ReturnType<typeof httpRequest>> = [];
  const statuses = Array.from({ length: 12 }, () =>
    new Promise<number>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/job",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": "2" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", () => resolve(-1));
      req.write("{");
      requests.push(req);
    }));
  await pause(300);
  for (const req of requests) req.end("}");
  await pause(300);
  try {
    assert.ok(peak <= 2, `${peak} jobs were active with maxJobs=2`);
  } finally {
    await server.close();
    await Promise.all(statuses);
  }
});

// ---------------------------------------------------------------------------
// 16. server.run's fuzzy fallback matched substrings: `dd` ran math.add, so a
//     typo could trigger a real side effect. An empty normalised name matched
//     every action.
// ---------------------------------------------------------------------------
test("regression: server.run does not resolve a partial or empty name to a real action", async () => {
  let ran = 0;
  const server = new NegotiationServer();
  server.use({
    "math.add": async ({ a, b }: { a: number; b: number }) => {
      ran += 1;
      return a + b;
    },
  });
  await assert.rejects(server.run.dd({ a: 1, b: 2 }), /Unknown server action/);
  await assert.rejects(server.run["..."]({}), /Unknown server action/);
  assert.equal(ran, 0);
  // The documented normalised name still resolves.
  assert.equal(await server.run.mathAdd({ a: 2, b: 3 }), 5);
});

// ---------------------------------------------------------------------------
// 17. A callback URL's path was added to a global set that is checked before
//     routes, so POSTs to a route with that path were answered as callbacks
//     (403) and the set grew without bound.
// ---------------------------------------------------------------------------
test("regression: a callback URL cannot take over a path that a route serves", async () => {
  const server = new NegotiationServer({ callbackTimeoutMs: 200 });
  server.use({ "hooks.quick": async () => "noop" });
  server.handle("/orders", async () => ({ ok: true }));
  server.handle("/hook", async () => ({ ok: true }));
  server.handle("/setup", async () => {
    const refusals: string[] = [];
    for (const callbackPath of ["/orders", "https://partner.example/hook"]) {
      await server.callback("hooks.quick", {}, callbackPath).catch((error: Error) => {
        refusals.push(error.message);
      });
    }
    return refusals;
  });

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    const refusals = (await client.call({ url: `${baseUrl}/setup` })) as string[];
    assert.equal(refusals.length, 2);
    for (const message of refusals) assert.match(message, /is a route on this server/);
    assert.deepEqual(await client.call({ url: `${baseUrl}/orders` }), { ok: true });
    assert.deepEqual(await client.call({ url: `${baseUrl}/hook` }), { ok: true });
  });
});

// ---------------------------------------------------------------------------
// 18. The client sent the resume request, with the caller's headers and the
//     resume token, to whatever origin the server named, including other hosts.
// ---------------------------------------------------------------------------
function readAll(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });
}

test("regression: the client refuses to send a resume request to another origin", async () => {
  let otherOriginRequests = 0;
  const other = createHttpServer(async (req, res) => {
    otherOriginRequests += 1;
    await readAll(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ protocol: 1, jobId: "j1", round: 2, done: true, result: "ok", actions: [] }));
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherPort = (other.address() as AddressInfo).port;

  const origin = createHttpServer(async (req, res) => {
    await readAll(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      protocol: 1, jobId: "j1", round: 1, done: false, result: null,
      actions: [{ name: "ping", data: null, callbackID: "cb1" }],
      resumeUrl: `http://127.0.0.1:${otherPort}/steal`,
      resumeToken: "resume-token-123",
    }));
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as AddressInfo).port;

  const client = new NegotiationClient();
  client.provide({ ping: async () => "pong" });
  try {
    await assert.rejects(
      client.call({ url: `http://127.0.0.1:${originPort}/job`, headers: { authorization: "Bearer SECRET" } }),
      /same origin/,
    );
    assert.equal(otherOriginRequests, 0);
  } finally {
    origin.closeAllConnections();
    origin.close();
    other.closeAllConnections();
    other.close();
  }
});

// ---------------------------------------------------------------------------
// 19. Two end() calls made without await both passed the `ended` check before
//     either set it, so onCallEnd ran more than once.
// ---------------------------------------------------------------------------
test("regression: end() called twice runs onCallEnd once", async () => {
  let hookRuns = 0;
  const server = new NegotiationServer();
  server.plugin({
    onCallEnd: async () => {
      hookRuns += 1;
      await pause(30);
    },
  });
  server.handle("/job", async () => {
    void server.end("a");
    void server.end("b");
  });

  await withServer(server, async (baseUrl) => {
    await new NegotiationClient().call({ url: `${baseUrl}/job` });
    await pause(100);
    assert.equal(hookRuns, 1);
  });
});

// ---------------------------------------------------------------------------
// 20. After a job expired, a handler that caught the expiry error could still
//     start a round. The client ran the service (a side effect) before its
//     resume failed with UNKNOWN_JOB, and the client never saw JOB_EXPIRED.
// ---------------------------------------------------------------------------
test("regression: an expired job starts no new rounds and reports JOB_EXPIRED", async () => {
  let charges = 0;
  const server = new NegotiationServer({ jobTimeoutMs: 300, callbackTimeoutMs: 60_000, requestTimeoutMs: 2_000 });
  server.use({ "hooks.never": async () => new Promise(() => undefined) });
  let handlerSaw = "";
  server.handle("/job", async () => {
    try {
      await server.callback("hooks.never", {});
    } catch (error) {
      handlerSaw += `${(error as { code?: string }).code} `;
    }
    try {
      await server.require("charge");
      handlerSaw += "round-issued";
    } catch (error) {
      handlerSaw += `require:${(error as { code?: string }).code}`;
    }
    return "done";
  });
  const client = new NegotiationClient({ requestTimeoutMs: 5_000 });
  client.provide({
    charge: async () => {
      charges += 1;
      return "charged";
    },
  });

  await withServer(server, async (baseUrl) => {
    await assert.rejects(
      client.call({ url: `${baseUrl}/job` }),
      (error: unknown) => (error as { code?: string }).code === "JOB_EXPIRED",
    );
  });
  assert.equal(charges, 0, "the client executed a service for an expired job");
  assert.match(handlerSaw, /require:JOB_EXPIRED/);
});

// ---------------------------------------------------------------------------
// 21. Callback URLs are recognised by the path they were created with, and
//     route lookup comes after that check. The fix must keep working for a
//     callback on a path no route claims, so this is the positive control.
// ---------------------------------------------------------------------------
test("regression: an external callback still completes on a path no route serves", async () => {
  const server = new NegotiationServer();
  server.use({
    "hooks.quote": async (data: { callbackUrl: string }) => {
      void fetch(data.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId: "Q-1" }),
      });
      return "scheduled";
    },
  });
  server.handle("/quote", async () => await server.callback("hooks.quote", {}, "/hooks/carrier"));

  await withServer(server, async (baseUrl) => {
    assert.deepEqual(await new NegotiationClient().call({ url: `${baseUrl}/quote` }), { quoteId: "Q-1" });
  });
});
