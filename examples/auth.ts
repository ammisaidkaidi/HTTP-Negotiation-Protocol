import { createServer as createHttpServer } from "node:http";
import { ClientAuthManager, NegotiationClient } from "../src/client/index.js";
import { NegotiationServer, ServerAuthManager } from "../src/server/index.js";

// Demo of the challenge-response auth flow (src/common/auth.ts + client/server managers), bound to the
// negotiation client/server:
//   begin -> time sync (clocks must agree within 20,000 ms) -> uid ->
//   encrypted challenge (function names + data, key = HKDF(pwd, time\20000))
//   -> encrypted answer -> server saves token to its registry, sends it ->
//   ack -> connection closed. After close(), a fresh auth process runs.
//
// ServerAuthManager(negotiationServer, ...) registers /auth on the
// NegotiationServer; one attached HTTP server serves both. (The
// NegotiationServer has no listen() of its own — the app owns HTTP.)
// ClientAuthManager(negotiationClient, ...) makes that client send
// `authorization: Bearer <token>` automatically after authenticate().

const users: Record<string, string> = {
  user1: "correct-horse",
};

async function main(): Promise<void> {
  const port = Number(process.env.AUTH_PORT ?? 4000);
  const baseUrl = `http://127.0.0.1:${port}`;

  const negotiationServer = new NegotiationServer();
  // A route that reports whether the caller presented a registered token.
  negotiationServer.handle("/whoami", async (request) => {
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const entry = authServer.validateToken(token);
    return { authenticated: entry !== undefined, uid: entry?.uid ?? null };
  });

  const authServer = new ServerAuthManager(negotiationServer, {
    // Per-user password lookup (could read a DB / secret manager instead).
    getPassword: async (uid) => users[uid],
  });
  const httpServer = createHttpServer(authServer.requestHandler());
  authServer.attach(httpServer);
  await authServer.listen(port, "127.0.0.1"); // serves /auth + negotiation routes
  console.log(`Auth + negotiation server listening on ${baseUrl} (auth at /auth)`);

  const negotiationClient = new NegotiationClient();
  const clientAuth = new ClientAuthManager(negotiationClient, {
    authUrl: `${baseUrl}/auth`,
    uid: "user1",
    password: "correct-horse",
  });

  try {
    console.log("before auth:", await negotiationClient.call({ url: `${baseUrl}/whoami`, data: {} }));

    const session = await clientAuth.authenticate();
    console.log("AUTH SUCCESS", {
      uid: session.uid,
      token: `${session.token.slice(0, 8)}...`,
      clockOffsetMs: clientAuth.lastClockOffsetMs?.toFixed(2),
      registryEntry: authServer.validateToken(session.token),
    });
    console.log("after auth: ", await negotiationClient.call({ url: `${baseUrl}/whoami`, data: {} }));

    clientAuth.close(); // connection closed: token forgotten, header no longer sent
    console.log("after close:", await negotiationClient.call({ url: `${baseUrl}/whoami`, data: {} }));

    const fresh = await clientAuth.authenticate({ force: true });
    console.log("RE-AUTH AFTER CLOSE", {
      newToken: fresh.token !== session.token,
      uid: fresh.uid,
    });
  } finally {
    clientAuth.close();
    await authServer.close(); // also closes the NegotiationServer + HTTP server
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
