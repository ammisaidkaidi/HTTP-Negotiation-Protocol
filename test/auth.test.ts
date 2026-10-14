import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { ClientAuthManager, NegotiationClient } from "../src/client/index.js";
import { NegotiationServer, ServerAuthManager } from "../src/server/index.js";

async function findFreePort(): Promise<number> {
  const probe = createNetServer();
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

const passwords: Record<string, string> = { user1: "correct-horse", user2: "battery-staple" };

async function withAuthServer(
  server: ServerAuthManager,
  run: (authUrl: string) => Promise<void>,
): Promise<void> {
  const port = await findFreePort();
  // NegotiationServer has no listen(): the application owns the HTTP server.
  const httpServer = createHttpServer(server.requestHandler());
  server.attach(httpServer);
  await server.listen(port, "127.0.0.1");
  try {
    await run(`http://127.0.0.1:${port}/auth`);
  } finally {
    await server.close();
  }
}

test("full auth flow: begin, time sync, uid, encrypted challenge, token in registry, ack", async () => {
  const server = new ServerAuthManager(new NegotiationServer(), { getPassword: (uid) => passwords[uid] });
  await withAuthServer(server, async (authUrl) => {
    const client = new ClientAuthManager(new NegotiationClient(), { authUrl, uid: "user1", password: "correct-horse" });
    const session = await client.authenticate();

    assert.ok(session.token.length >= 32);
    assert.equal(session.uid, "user1");
    assert.equal(client.isAuthenticated(), true);
    assert.equal(client.token, session.token);
    assert.ok(Math.abs(client.lastClockOffsetMs ?? 999) <= 20_000);

    // Server saved the token to its registry before sending it, and the
    // client's ack has been recorded against that same registry entry.
    const entry = server.validateToken(session.token);
    assert.equal(entry?.uid, "user1");
    assert.equal(entry?.acknowledged, true);
    assert.equal(server.server?.getJobCount(), 0); // auth job ended, connection closed

    // A second authenticate() reuses the still-valid in-memory token...
    const again = await client.authenticate();
    assert.equal(again.token, session.token);

    // ...but after close() (connection/process closed) a fresh auth process
    // runs and produces a new token.
    client.close();
    assert.equal(client.isAuthenticated(), false);
    const fresh = await client.authenticate({ force: true });
    assert.notEqual(fresh.token, session.token);
    assert.equal(server.validateToken(fresh.token)?.uid, "user1");
  });
});

test("auth fails for unknown uid, wrong password and revoked/expired tokens", async () => {
  const server = new ServerAuthManager(new NegotiationServer(), { getPassword: (uid) => passwords[uid], tokenTtlMs: 60_000 });
  await withAuthServer(server, async (authUrl) => {
    const unknown = new ClientAuthManager(new NegotiationClient(), { authUrl, uid: "ghost", password: "whatever123" });
    await assert.rejects(unknown.authenticate(), (error: any) => error?.code === "UNKNOWN_UID");

    const wrong = new ClientAuthManager(new NegotiationClient(), { authUrl, uid: "user1", password: "wrong-password" });
    await assert.rejects(wrong.authenticate(), (error: any) =>
      error?.code === "DECRYPT_FAILED" || error?.code === "CHALLENGE_FAILED");
    assert.equal(server.registry.size, 0); // no token was ever registered

    const client = new ClientAuthManager(new NegotiationClient(), { authUrl, uid: "user2", password: "battery-staple" });
    const session = await client.authenticate();
    assert.equal(server.validateToken(session.token)?.uid, "user2");
    assert.equal(server.revokeToken(session.token), true);
    assert.equal(server.validateToken(session.token), undefined);
  });
});

test("auth fails when client and server clocks differ by more than 20,000 ms", async () => {
  const server = new ServerAuthManager(new NegotiationServer(), { getPassword: (uid) => passwords[uid] });
  await withAuthServer(server, async (authUrl) => {
    const skewed = new ClientAuthManager(new NegotiationClient(), {
      authUrl,
      uid: "user1",
      password: "correct-horse",
      now: () => Date.now() + 30_000, // 30 s fast: outside the 20,000 ms budget
    });
    await assert.rejects(skewed.authenticate(), (error: any) => error?.code === "CLOCK_SKEW");
    assert.equal(server.registry.size, 0);
    assert.equal(server.server?.getJobCount(), 0);
  });
});

test("auth negotiation rejects a client that answers the challenge incorrectly", async () => {
  const server = new ServerAuthManager(new NegotiationServer(), { getPassword: (uid) => passwords[uid] });
  await withAuthServer(server, async (authUrl) => {
    const negotiationClient = new NegotiationClient();
    const client = new ClientAuthManager(negotiationClient, {
      authUrl, uid: "user1", password: "correct-horse",
    });
    // Override the solver with a bogus (unencrypted) answer after registration:
    negotiationClient.use({ "auth.solveChallenge": async () => ({ result: -1, nonce: "bogus" }) });
    await assert.rejects(client.authenticate(), (error: any) =>
      error?.code === "DECRYPT_FAILED" || error?.code === "CHALLENGE_FAILED");
    assert.equal(server.registry.size, 0); // no token was ever registered
    assert.equal(client.isAuthenticated(), false);
  });
});

test("managers bound to NegotiationClient/NegotiationServer share one HTTP server and carry the token", async () => {
  // Server side: one NegotiationServer + ServerAuthManager bound to it.
  const negotiationServer = new NegotiationServer({ requestTimeoutMs: 5_000 });
  negotiationServer.handle("/whoami", async (request) => {
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const entry = authServer.validateToken(token);
    return { authenticated: entry !== undefined, uid: entry?.uid ?? null };
  });
  const authServer = new ServerAuthManager(negotiationServer, {
    getPassword: (uid) => passwords[uid],
  });
  assert.equal(authServer.server, negotiationServer);
  assert.equal(authServer.negotiationServer, negotiationServer); // alias

  // Client side: one NegotiationClient + ClientAuthManager bound to it.
  const negotiationClient = new NegotiationClient();
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const clientAuth = new ClientAuthManager(negotiationClient, {
    authUrl: `${baseUrl}/auth`,
    uid: "user1",
    password: "correct-horse",
  });
  assert.equal(clientAuth.negotiationClient, negotiationClient);

  // One attached HTTP server serves /auth AND negotiation routes.
  const httpServer = createHttpServer(authServer.requestHandler());
  authServer.attach(httpServer);
  await authServer.listen(port, "127.0.0.1");
  try {
    assert.equal(negotiationServer.httpServer !== undefined, true);
    assert.equal(authServer.httpServer, negotiationServer.httpServer);
    assert.equal(authServer.httpServer, httpServer);

    // Before auth: no token header is sent.
    assert.deepEqual(
      await negotiationClient.call({ url: `${baseUrl}/whoami`, data: {} }),
      { authenticated: false, uid: null },
    );

    // After auth: the bound NegotiationClient sends the token automatically.
    await clientAuth.authenticate();
    assert.deepEqual(
      await negotiationClient.call({ url: `${baseUrl}/whoami`, data: {} }),
      { authenticated: true, uid: "user1" },
    );

    // After close(): the header is gone again without touching the client setup.
    clientAuth.close();
    assert.deepEqual(
      await negotiationClient.call({ url: `${baseUrl}/whoami`, data: {} }),
      { authenticated: false, uid: null },
    );
  } finally {
    await authServer.close(); // also closes the NegotiationServer + HTTP server
  }
  assert.equal(negotiationServer.httpServer, undefined);
});

test("ServerAuthManager.listen requires a bound server with an attached HTTP server", async () => {
  const standalone = new ServerAuthManager({ getPassword: (uid) => passwords[uid] });
  assert.equal(standalone.server, undefined);
  await assert.rejects(standalone.listen(0), /requires a bound NegotiationServer \(this\.server\)/);

  // Bound, but nothing attached yet: NegotiationServer has no listen()
  // to fall back to, so the manager asks the application to attach one.
  const unattached = new ServerAuthManager(new NegotiationServer(), { getPassword: (uid) => passwords[uid] });
  await assert.rejects(unattached.listen(0), /attach\(httpServer\), /);
});

test("Web Crypto auth envelopes encrypt, decrypt, and generate keys without Node crypto imports", async () => {
  const {
    encryptAuthPayloadAsync,
    decryptAuthPayloadAsync,
    generateAuthKey,
  } = await import("../src/common/authCrypto.js");
  const payload = { data: 42, challenge: ["double"], nonce: "web-crypto" };

  const envelope = await encryptAuthPayloadAsync(payload, "correct-horse");
  assert.equal(envelope.alg, "AES-256-GCM-HKDF-SHA256");
  assert.deepEqual(await decryptAuthPayloadAsync(envelope, "correct-horse"), payload);

  await assert.rejects(
    decryptAuthPayloadAsync(envelope, "wrong-password"),
    (error: any) => error?.code === "DECRYPT_FAILED",
  );

  // crypto.subtle.generateKey path used for fresh random AES-GCM keys.
  const generated = await generateAuthKey();
  assert.equal(typeof generated, "object");
  assert.notEqual(generated, null);
});

test("auth succeeds with a clock difference inside the 20,000 ms window and reports UTC startup time", async () => {
  const server = new ServerAuthManager(new NegotiationServer(), { getPassword: (uid) => passwords[uid] });
  assert.match(server.startedAtUtc, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.match(server.universalTime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  await withAuthServer(server, async (authUrl) => {
    const client = new ClientAuthManager(new NegotiationClient(), {
      authUrl,
      uid: "user1",
      password: "correct-horse",
      now: () => Date.now() + 5_000, // inside the widened 20,000 ms window
    });
    const session = await client.authenticate();
    assert.equal(session.uid, "user1");
    assert.ok(Math.abs(client.lastClockOffsetMs ?? 0) > 4_000);
    assert.ok(Math.abs(client.lastClockOffsetMs ?? 0) <= 20_000);
  });
});
