import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import {
  haltRequest,
  NegotiationClient,
  RequestHaltedError,
} from "../src/client/index.js";
import type { ClientPlugin } from "../src/common/negotiations.js";
import { NegotiationServer } from "../src/server/index.js";

interface Rig {
  baseUrl: string;
  jobsStarted: number;
  close: () => Promise<void>;
}

async function startServer(): Promise<Rig> {
  const server = new NegotiationServer();
  const rig: Rig = {
    baseUrl: "",
    jobsStarted: 0,
    close: () => server.close(),
  };
  server.plugin({
    onJobStart: () => {
      rig.jobsStarted += 1;
    },
  });
  server.handle("/example", async () => {
    const name = await server.ask.getName();
    return { greeting: `Hello ${name}` };
  });
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test server");
  rig.baseUrl = `http://127.0.0.1:${address.port}`;
  return rig;
}

test("client plugins run as an awaited chain in registration order before fetch", async () => {
  const rig = await startServer();
  const events: string[] = [];
  try {
    const client = new NegotiationClient();
    client.use([
      {
        onRequest: async () => {
          events.push("plug1:start");
          await new Promise((resolve) => setTimeout(resolve, 15)); // async hold
          events.push("plug1:end");
        },
      },
      { onRequest: () => { events.push("plug2"); } },
      {
        onRequest: (req) => {
          events.push("plug3");
          req.headers["x-plug"] = "3";
        },
        onResponse: () => { events.push("response"); },
      },
    ]);
    client.use({ getName: async () => "Alex" });

    const result = await client.call({ url: `${rig.baseUrl}/example`, data: {} });
    assert.deepEqual(result, { greeting: "Hello Alex" });
    // Ordering: the async hold completes before plug2/plug3 run, and the
    // same order repeats for the resume round.
    assert.deepEqual(events.slice(0, 4), ["plug1:start", "plug1:end", "plug2", "plug3"]);
    assert.equal(rig.jobsStarted, 1);
  } finally {
    await rig.close();
  }
});

test("returning false from onRequest halts with REQUEST_HALTED, skips later plugins and fetch", async () => {
  const rig = await startServer();
  const seen: string[] = [];
  const errors: string[] = [];
  try {
    const client = new NegotiationClient();
    client.use([
      { onRequest: () => { seen.push("plug1"); } },
      { onRequest: () => false }, // plug2: not permitted -> halt
      { onRequest: () => { seen.push("plug3"); } },
      {
        onError: (error) => {
          errors.push(`${(error as { code?: string }).code}:${error.message}`);
        },
      },
    ]);
    client.use({ getName: async () => "Alex" });

    await assert.rejects(client.call({ url: `${rig.baseUrl}/example`, data: {} }), (error: unknown) => {
      assert.ok(error instanceof RequestHaltedError);
      assert.equal((error as { code?: string }).code, "REQUEST_HALTED");
      return true;
    });
    assert.deepEqual(seen, ["plug1"]); // plug3 never ran
    assert.deepEqual(errors, ["REQUEST_HALTED:Request halted by a client plugin"]); // routed through onError
    assert.equal(rig.jobsStarted, 0); // fetch never happened
  } finally {
    await rig.close();
  }
});

test("haltRequest() halts with a custom message, and thrown plugin errors reach onError", async () => {
  const rig = await startServer();
  const errors: string[] = [];
  try {
    const client = new NegotiationClient();
    const phaseGuard: ClientPlugin = {
      onRequest: (req) => {
        if (req.phase === "initial") haltRequest("not permitted in this phase");
      },
      onError: (error) => { errors.push(error.message); },
    };
    client.use(phaseGuard);
    client.use({ getName: async () => "Alex" });
    await assert.rejects(client.call({ url: `${rig.baseUrl}/example`, data: {} }), /not permitted in this phase/);
    assert.equal(rig.jobsStarted, 0);

    const client2 = new NegotiationClient();
    const exploding: ClientPlugin = {
      onRequest: () => { throw new Error("plugin exploded"); },
      onError: (error) => { errors.push(error.message); },
    };
    client2.use(exploding);
    client2.use({ getName: async () => "Alex" });
    await assert.rejects(client2.call({ url: `${rig.baseUrl}/example`, data: {} }), /plugin exploded/);

    assert.deepEqual(errors, ["not permitted in this phase", "plugin exploded"]);
  } finally {
    await rig.close();
  }
});
