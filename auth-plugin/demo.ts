import { createServer as createHttpServer } from "node:http";
import { NegotiationClient } from "../src/client/index.js";
import { NegotiationServer } from "../src/server/index.js";
import { createClientAuth, createServerAuth } from "./index.js";

// Demo of the auth-plugin framework (auth-plugin/): challenge-response auth
// expressed entirely as plugins — no manager classes.
//   begin -> time sync (clocks must agree within 20,000 ms) -> uid ->
//   encrypted challenge (function names + data, key = HKDF(pwd, time\20000))
//   -> encrypted answer -> server saves token to its store, sends it ->
//   ack -> session. After close(), a fresh login runs.

const users: Record<string, string> = {
  user1: "correct-horse",
};

async function main(): Promise<void> {
  const port = Number(process.env.AUTH_PORT ?? 4000);
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = new NegotiationServer();
  const auth = createServerAuth({
    getPassword: async (uid) => users[uid],
    publicPaths: ["/whoami"], // reachable without a token so it can report status
  });
  auth.register(server); // installs the guard plugin + the /auth login route

  // Public: reports whether the caller presented a registered token.
  server.handle("/whoami", async (request) => {
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const entry = await auth.validateToken(token);
    return { authenticated: entry !== undefined, uid: entry?.uid ?? null };
  });

  // Protected by the auth plugin: this handler only runs with a valid token.
  server.handle("/profile", async () => ({ plan: "pro", seats: 3 }));

  // HELD-REQUEST catalogue (auth.protect): "/products?all" while not
  // authenticated does not fail immediately — the server holds the job at
  // the guard point, asks the client to log in in-job, and continues the
  // very same request when auth succeeds. (Query string is ignored by
  // route matching; the route is "/products".)
  auth.protect("/products", async () => ({
    products: [
      { sku: "A", price: 1200 },
      { sku: "B", price: 3400 },
      { sku: "C", price: 800 },
    ],
  }));

  const httpServer = createHttpServer(server.requestHandler());
  server.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  console.log(`Auth-plugin demo listening on ${baseUrl} (login at /auth)`);

  const client = new NegotiationClient();
  // Credentials are NOT options: the client is bound here, uid/pwd go to login().
  const clientAuth = createClientAuth({
    authUrl: `${baseUrl}/auth`,
    client,
    onAuthStateChanged: (state) => console.log("auth state ->", state),
  });

  try {
    console.log("before auth /whoami:", await client.call({ url: `${baseUrl}/whoami`, data: {} }));
    try {
      await client.call({ url: `${baseUrl}/profile`, data: {} });
    } catch (error) {
      console.log("before auth /profile rejected:", (error as { code?: string }).code);
    }

    // SIMULATION: send "/products?all" while NOT authenticated.
    // The plugin has no session and no credentials yet, so the server's
    // AUTH_REQUIRED answer reaches the caller (the plugin cannot invent
    // credentials — someone must login({ uid, pwd }) once).
    try {
      await client.call({ url: `${baseUrl}/products?all`, data: {} });
      console.log("SIMULATION /products?all: unexpectedly succeeded");
    } catch (error) {
      console.log("SIMULATION /products?all while not auth -> rejected:",
        (error as { code?: string }).code, "-", (error as Error).message);
    }

    const session = await clientAuth.login({ uid: "user1", pwd: "correct-horse" });
    console.log("AUTH SUCCESS", {
      uid: session.uid,
      token: `${session.token.slice(0, 8)}...`,
      clockOffsetMs: clientAuth.lastClockOffsetMs?.toFixed(2),
      registryEntry: await auth.validateToken(session.token),
    });
    console.log("after auth /whoami: ", await client.call({ url: `${baseUrl}/whoami`, data: {} }));
    console.log("after auth /profile:", await client.call({ url: `${baseUrl}/profile`, data: {} }));
    console.log("SIMULATION /products?all after auth ->",
      await client.call({ url: `${baseUrl}/products?all`, data: {} }));

    // Server forgets the token: the next call gets AUTH_REQUIRED, the auth
    // plugin captures it, re-runs the login itself, and the call continues.
    await auth.revokeToken(session.token);
    console.log("token revoked on server; calling /profile (auto re-auth expected)...");
    console.log("auto re-auth /profile:", await client.call({ url: `${baseUrl}/profile`, data: {} }));

    // Server forgets the NEW token too: /products?all is a protect() route,
    // so this time the job is HELD at the server guard point, the client
    // logs in in-job (auth.login), and the SAME call continues — one
    // client.call(), no error, no retry.
    await auth.revokeToken(clientAuth.getToken() as string);
    console.log("token revoked again; calling /products?all (held-request continuation expected)...");
    console.log("held-request /products?all:", await client.call({ url: `${baseUrl}/products?all`, data: {} }));

    clientAuth.close(); // token AND credentials forgotten; header no longer sent
    console.log("after close /whoami:", await client.call({ url: `${baseUrl}/whoami`, data: {} }));

    const fresh = await clientAuth.login({ uid: "user1", pwd: "correct-horse", force: true });
    console.log("RE-AUTH AFTER CLOSE", { newToken: fresh.token !== session.token, uid: fresh.uid });
  } finally {
    clientAuth.close();
    await server.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
