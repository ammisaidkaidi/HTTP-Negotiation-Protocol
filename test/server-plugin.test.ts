import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import { NegotiationClient } from "../src/client/index.js";
import {
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
    onJobStart: (job) => {
      events.push(`start:${job.path}:round${job.round}`);
    },
    onRound: (round) => {
      events.push(`round${round.round}:${round.actions.map((a) => a.name).join("+")}`);
    },
    onJobEnd: (job) => {
      events.push(`end:${JSON.stringify(job.result)}`);
    },
    onJobError: (job) => {
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
    "round1:getName",
    "round2:getCity",
    'end:{"name":"Alex","city":"Graz"}',
  ]);
});

test("server plugins accept an array and onJobError observes handler failures", async () => {
  const events: string[] = [];
  const server = new NegotiationServer();
  server.plugin([recorder(events), { name: "noop" }]);
  server.handle("/boom", async () => {
    throw new Error("boom");
  });

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    await assert.rejects(client.call({ url: `${baseUrl}/boom`, data: {} }), /boom/);
  });

  assert.deepEqual(events, ["start:/boom:round0", "error:boom"]);
});

test("a throwing onJobStart fails the job and still fires onJobError", async () => {
  const events: string[] = [];
  const server = new NegotiationServer();
  server.plugin({
    onJobStart: () => {
      throw new Error("plugin refused the job");
    },
    onJobError: (job) => {
      events.push(`error:${job.error.message}`);
    },
  });
  server.handle("/example", async () => ({ ok: true }));

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    await assert.rejects(
      client.call({ url: `${baseUrl}/example`, data: {} }),
      /plugin refused the job/,
    );
  });

  assert.deepEqual(events, ["error:plugin refused the job"]);
});

test("a throwing onJobEnd is reported via onError and never changes the result", async () => {
  const reported: string[] = [];
  const server = new NegotiationServer({
    onError: (error, info) => reported.push(`${info.phase}:${error.message}`),
  });
  server.plugin({
    onJobEnd: () => {
      throw new Error("observer exploded");
    },
  });
  server.handle("/example", async () => ({ ok: true }));

  await withServer(server, async (baseUrl) => {
    const client = new NegotiationClient();
    const result = await client.call({ url: `${baseUrl}/example`, data: {} });
    assert.deepEqual(result, { ok: true });
  });

  assert.deepEqual(reported, ["plugin:onJobEnd:observer exploded"]);
});

test("plugin() validates its input", () => {
  const server = new NegotiationServer();
  assert.throws(() => server.plugin({ onRound: "nope" } as never), TypeError);
  assert.throws(() => server.plugin(42 as never), TypeError);
});
