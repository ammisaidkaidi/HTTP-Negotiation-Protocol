import { createServer as createHttpServer } from "node:http";
import express from "express";
import {
  NegotiationClient,
  NegotiationServer,
} from "../src/protocol.js";

// The negotiation server no longer needs to own an HTTP server:
// requestHandler() plugs the whole protocol (routes, resume endpoint,
// external callbacks) into any Node-style framework.

const server = new NegotiationServer({ requestTimeoutMs: 120_000 });

server.use({
  "math.add": async ({ a, b }: { a: number; b: number }) => a + b,
});

server.handle("/example", async () => {
  const name = await server.ask.getName();
  const sum = await server.run.math.add({ a: 2, b: 3 });
  return { name, sum }; // returning a value auto-ends the job
});

const app = express();
app.use(express.json()); // optional — pre-parsed bodies are honoured
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.use(server.requestHandler()); // mount at the root, after your own routes

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const http = createHttpServer(app);
  // Attach so the negotiation server tracks this HTTP server: `httpServer`
  // becomes set, close/error events are wired, and server.close() below
  // closes the HTTP server too. (Without attach(), server.httpServer stays
  // undefined and server.close() would only clean up jobs/store.)
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  console.log(`Express + negotiation demo listening on http://127.0.0.1:${port}`);

  const client = new NegotiationClient();
  client.use({ getName: async () => "Alex" });

  try {
    const result = await client.call({
      url: `http://127.0.0.1:${port}/example`,
      data: {},
    });
    console.log("\nFINAL RESULT\n", JSON.stringify(result, null, 2));
  } finally {
    // Because of attach(), this one call closes the Express HTTP server,
    // rejects any pending negotiation jobs, and closes the store.
    await server.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
