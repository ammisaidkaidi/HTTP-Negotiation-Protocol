import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import { NegotiationClient } from "../src/client/index.js";
import type { ClientPlugin } from "../src/common/negotiations.js";
import { NegotiationServer } from "../src/server/index.js";

const SECRET = "SECRET_CITY";

interface Rig {
  baseUrl: string;
  rounds: unknown[];
  close: () => Promise<void>;
}

async function startRig(): Promise<Rig> {
  const rounds: unknown[] = [];
  const server = new NegotiationServer();
  server.plugin({
    name: "recorder",
    onRound: (round) => {
      rounds.push(round);
    },
  });
  server.handle("/locate", async () => {
    const location = await server.ask.getLocation({ precision: "gps" });
    return { location };
  });
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test server");
  return { baseUrl: `http://127.0.0.1:${address.port}`, rounds, close: () => server.close() };
}

test("plugins cannot observe asks/responseAsks: no action names, no results, anywhere", async () => {
  const rig = await startRig();
  const seenByPlugins: string[] = [];
  try {
    const client = new NegotiationClient();
    const spy: ClientPlugin = {
      onRequest: (req) => {
        seenByPlugins.push(`request:${req.phase}:${JSON.stringify(req.body)}`);
        req.headers["x-spy"] = "1"; // header changes still allowed (auth relies on this)
      },
      onResponse: (body) => {
        seenByPlugins.push(`response:${JSON.stringify(body)}`);
      },
      onError: (error, req) => {
        seenByPlugins.push(`error:${error.message}:${JSON.stringify(req.body)}`);
      },
    };
    client.use(spy);
    client.use({ getLocation: async () => ({ city: SECRET }) });

    const result = await client.call({ url: `${rig.baseUrl}/locate`, data: {} });
    // The negotiation itself worked end to end, server got the real result.
    assert.deepEqual(result, { location: { city: SECRET } });

    const pluginView = seenByPlugins.join("\n");
    assert.ok(!pluginView.includes("getLocation"), "plugins must not see asked action names");
    assert.ok(!pluginView.includes('"results"'), "plugins must not see the results payload");
    assert.ok(pluginView.includes("__redacted"), "resume requests must reach plugins redacted");
    // The ask round-trip itself leaked nothing: every entry recorded BEFORE
    // the final envelope (the app's own result, which plugins may see as
    // before) is free of the service result.
    const roundTripEntries = seenByPlugins.filter((e) => e.startsWith("request:resume") || e.includes('"done":false'));
    assert.ok(roundTripEntries.length >= 2);
    assert.ok(!roundTripEntries.join("\n").includes(SECRET), "ask round-trip must not leak service results");

    // Server side: onRound fired, but its payload carries no actions at all.
    assert.equal(rig.rounds.length, 1);
    assert.equal("actions" in (rig.rounds[0] as Record<string, unknown>), false);
  } finally {
    await rig.close();
  }
});

test("plugins can still halt a resume request (control without observation)", async () => {
  const rig = await startRig();
  try {
    const client = new NegotiationClient();
    const halter: ClientPlugin = {
      onRequest: (req) => {
        if (req.phase === "resume") return false; // halt blind: no body visible, still allowed
      },
    };
    client.use(halter);
    client.use({ getLocation: async () => ({ city: SECRET }) });
    await assert.rejects(client.call({ url: `${rig.baseUrl}/locate`, data: {} }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "REQUEST_HALTED");
      return true;
    });
  } finally {
    await rig.close();
  }
});
