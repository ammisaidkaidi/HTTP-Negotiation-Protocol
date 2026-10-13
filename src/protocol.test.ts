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
