import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  ClientAuthManager,
  ServerAuthManager,
} from "./index.js";

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

const passwords: Record<string, string> = { user1: "correct-horse", user2: "battery-staple" };

async function withAuthServer(
  server: ServerAuthManager,
  run: (authUrl: string) => Promise<void>,
): Promise<void> {
  const port = await findFreePort();
  await server.listen(port, "127.0.0.1");
  try {
    await run(`http://127.0.0.1:${port}/auth`);
  } finally {
    await server.close();
  }
}

test("full auth flow: begin, time sync, uid, encrypted challenge, token in registry, ack", async () => {
  const server = new ServerAuthManager({ getPassword: (uid) => passwords[uid] });
  await withAuthServer(server, async (authUrl) => {
    const client = new ClientAuthManager({ authUrl, uid: "user1", password: "correct-horse" });
    const session = await client.authenticate();

    assert.ok(session.token.length >= 32);
    assert.equal(session.uid, "user1");
    assert.equal(client.isAuthenticated(), true);
    assert.equal(client.token, session.token);
    assert.ok(Math.abs(client.lastClockOffsetMs ?? 999) <= 50);

    // Server saved the token to its registry before sending it, and the
    // client's ack has been recorded against that same registry entry.
    const entry = server.validateToken(session.token);
    assert.equal(entry?.uid, "user1");
    assert.equal(entry?.acknowledged, true);
    assert.equal(server.getPendingCount(), 0); // handshake connection closed

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
  const server = new ServerAuthManager({ getPassword: (uid) => passwords[uid], tokenTtlMs: 60_000 });
  await withAuthServer(server, async (authUrl) => {
    const unknown = new ClientAuthManager({ authUrl, uid: "ghost", password: "whatever123" });
    await assert.rejects(unknown.authenticate(), (error: any) => error?.code === "UNKNOWN_UID");

    const wrong = new ClientAuthManager({ authUrl, uid: "user1", password: "wrong-password" });
    await assert.rejects(wrong.authenticate(), (error: any) =>
      error?.code === "DECRYPT_FAILED" || error?.code === "CHALLENGE_FAILED");
    assert.equal(server.registry.size, 0); // no token was ever registered

    const client = new ClientAuthManager({ authUrl, uid: "user2", password: "battery-staple" });
    const session = await client.authenticate();
    assert.equal(server.validateToken(session.token)?.uid, "user2");
    assert.equal(server.revokeToken(session.token), true);
    assert.equal(server.validateToken(session.token), undefined);
  });
});

test("auth fails when client and server clocks differ by more than 50 ms", async () => {
  const server = new ServerAuthManager({ getPassword: (uid) => passwords[uid] });
  await withAuthServer(server, async (authUrl) => {
    const skewed = new ClientAuthManager({
      authUrl,
      uid: "user1",
      password: "correct-horse",
      now: () => Date.now() + 200, // 200 ms fast: outside the 50 ms budget
    });
    await assert.rejects(skewed.authenticate(), (error: any) => error?.code === "CLOCK_SKEW");
    assert.equal(server.registry.size, 0);
    assert.equal(server.getPendingCount(), 0);
  });
});

test("challenge functions are deterministic and the handshake rejects tampered answers (unit level)", async () => {
  const server = new ServerAuthManager({ getPassword: (uid) => passwords[uid] });
  // Drive the transport-agnostic state machine directly, tampering with the result.
  const begin: any = (await server.handleAuthMessage({ type: "begin" })).body;
  for (let i = 0; i < 5; i++) {
    await server.handleAuthMessage({ type: "time", authId: begin.authId, clientTime: Date.now() });
  }
  const commit = await server.handleAuthMessage({ type: "time_commit", authId: begin.authId, offsetMs: 0 });
  assert.equal(commit.status, 200);
  const challengeMessage: any = (await server.handleAuthMessage({ type: "uid", authId: begin.authId, uid: "user1" })).body;
  assert.equal(challengeMessage.type, "challenge");
  assert.ok(challengeMessage.payload?.data, "challenge payload is encrypted, not plaintext");
  const answer = await server.handleAuthMessage({
    type: "answer",
    authId: begin.authId,
    payload: { v: 1, alg: "AES-256-GCM-HKDF-SHA256", bucket: 0, iv: "", tag: "", data: "" },
  });
  assert.equal(answer.status, 403);
  assert.equal(server.registry.size, 0);
});
