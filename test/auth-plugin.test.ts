import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import test from "node:test";
import { NegotiationClient } from "../src/client/index.js";
import { NegotiationServer } from "../src/server/index.js";
import {
  AuthState,
  createClientAuth,
  createServerAuth,
  type ClientAuthOptions,
  type ServerAuthPlugin,
  type ServerAuthOptions,
} from "../auth-plugin/index.js";

const users: Record<string, string> = { user1: "correct-horse" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Rig {
  baseUrl: string;
  auth: ServerAuthPlugin;
  logins: string[];
  close: () => Promise<void>;
}

async function startRig(extra: ServerAuthOptions = {}): Promise<Rig> {
  const logins: string[] = [];
  const server = new NegotiationServer();
  const auth = createServerAuth({
    getPassword: async (uid) => users[uid],
    publicPaths: ["/whoami"],
    onLoginSuccess: ({ uid }) => logins.push(uid),
    ...extra,
  });
  auth.register(server);
  server.handle("/whoami", async (request) => {
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const entry = await auth.validateToken(token);
    return { authenticated: entry !== undefined, uid: entry?.uid ?? null };
  });
  server.handle("/profile", async () => ({ plan: "pro" })); // plain guard route
  auth.protect("/products", async () => ({ products: ["A", "B"] })); // held-request route
  const http: HttpServer = createHttpServer(server.requestHandler());
  server.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    auth,
    logins,
    close: () => server.close(),
  };
}

function makeClient(rig: Rig, extra: Partial<ClientAuthOptions> = {}) {
  const client = new NegotiationClient();
  const clientAuth = createClientAuth({ authUrl: `${rig.baseUrl}/auth`, client, ...extra });
  return { client, clientAuth };
}

const hasCode = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test("login: full negotiation issues an acknowledged token and opens guarded routes", async () => {
  const rig = await startRig();
  const states: AuthState[] = [];
  const { client, clientAuth } = makeClient(rig, { onAuthStateChanged: (s) => states.push(s) });
  try {
    const session = await clientAuth.login({ uid: "user1", pwd: "correct-horse" });
    assert.equal(session.uid, "user1");
    assert.ok(session.token.length > 10);
    assert.equal(clientAuth.isAuthenticated(), true);
    assert.equal(clientAuth.authState, AuthState.Authenticated);
    assert.deepEqual(states, [AuthState.Authenticating, AuthState.Authenticated]);

    const entry = await rig.auth.validateToken(session.token);
    assert.equal(entry?.uid, "user1");
    assert.equal(entry?.acknowledged, true);
    assert.deepEqual(rig.logins, ["user1"]);

    assert.deepEqual(await client.call({ url: `${rig.baseUrl}/whoami`, data: {} }),
      { authenticated: true, uid: "user1" });
    assert.deepEqual(await client.call({ url: `${rig.baseUrl}/profile`, data: {} }), { plan: "pro" });
  } finally {
    await rig.close();
  }
});

test("guard: protected routes reject AUTH_REQUIRED before login; public routes answer", async () => {
  const rig = await startRig();
  const { client } = makeClient(rig);
  try {
    await assert.rejects(client.call({ url: `${rig.baseUrl}/profile`, data: {} }), hasCode("AUTH_REQUIRED"));
    // protect() route without credentials: the in-job login cannot run either.
    await assert.rejects(client.call({ url: `${rig.baseUrl}/products?all`, data: {} }), hasCode("AUTH_REQUIRED"));
    assert.deepEqual(await client.call({ url: `${rig.baseUrl}/whoami`, data: {} }),
      { authenticated: false, uid: null });
  } finally {
    await rig.close();
  }
});

test("login: wrong password fails the challenge; no token is registered", async () => {
  const rig = await startRig();
  const { clientAuth } = makeClient(rig);
  try {
    await assert.rejects(
      clientAuth.login({ uid: "user1", pwd: "wrong-password" }),
      (error: unknown) => ["DECRYPT_FAILED", "CHALLENGE_FAILED"].includes((error as { code?: string }).code ?? ""),
    );
    assert.equal(clientAuth.isAuthenticated(), false);
    assert.equal(clientAuth.authState, AuthState.Unauthenticated);
    assert.deepEqual(rig.logins, []);
  } finally {
    await rig.close();
  }
});

test("login: unknown uid is rejected with UNKNOWN_UID", async () => {
  const rig = await startRig();
  const { clientAuth } = makeClient(rig);
  try {
    await assert.rejects(clientAuth.login({ uid: "ghost", pwd: "whatever" }), hasCode("UNKNOWN_UID"));
    assert.equal(clientAuth.isAuthenticated(), false);
  } finally {
    await rig.close();
  }
});

test("login: clock skew beyond 20s is rejected with CLOCK_SKEW", async () => {
  const rig = await startRig();
  const { clientAuth } = makeClient(rig, {
    clock: { now: () => Date.now() + 120_000 }, // client clock 2 minutes ahead
  });
  try {
    await assert.rejects(clientAuth.login({ uid: "user1", pwd: "correct-horse" }), hasCode("CLOCK_SKEW"));
    assert.equal(clientAuth.isAuthenticated(), false);
  } finally {
    await rig.close();
  }
});

test("auto re-auth: revoked token on a guard route triggers login + transparent retry", async () => {
  const rig = await startRig();
  const { client, clientAuth } = makeClient(rig);
  try {
    const session = await clientAuth.login({ uid: "user1", pwd: "correct-horse" });
    await rig.auth.revokeToken(session.token);
    // Caller sees one successful call; the plugin logged in again underneath.
    assert.deepEqual(await client.call({ url: `${rig.baseUrl}/profile`, data: {} }), { plan: "pro" });
    assert.deepEqual(rig.logins, ["user1", "user1"]);
    assert.notEqual(clientAuth.getToken(), session.token);
  } finally {
    await rig.close();
  }
});

test("held request: protect() route logs in in-job and continues the same call", async () => {
  const rig = await startRig();
  const { client, clientAuth } = makeClient(rig);
  try {
    const session = await clientAuth.login({ uid: "user1", pwd: "correct-horse" });
    await rig.auth.revokeToken(session.token);
    // One call: held at the guard point -> auth.login -> continuation -> result.
    assert.deepEqual(await client.call({ url: `${rig.baseUrl}/products?all`, data: {} }),
      { products: ["A", "B"] });
    assert.deepEqual(rig.logins, ["user1", "user1"]);
  } finally {
    await rig.close();
  }
});

test("autoLogin: false disables capture; AUTH_REQUIRED reaches the caller", async () => {
  const rig = await startRig();
  const { client, clientAuth } = makeClient(rig, { autoLogin: false });
  try {
    const session = await clientAuth.login({ uid: "user1", pwd: "correct-horse" });
    await rig.auth.revokeToken(session.token);
    await assert.rejects(client.call({ url: `${rig.baseUrl}/profile`, data: {} }), hasCode("AUTH_REQUIRED"));
    assert.deepEqual(rig.logins, ["user1"]); // no second login happened
  } finally {
    await rig.close();
  }
});

test("expiry: tokens die after tokenTtlMs on both server and client", async () => {
  const rig = await startRig({ tokenTtlMs: 60 });
  const { client, clientAuth } = makeClient(rig);
  try {
    const session = await clientAuth.login({ uid: "user1", pwd: "correct-horse" });
    assert.ok(await rig.auth.validateToken(session.token));
    await sleep(90);
    assert.equal(await rig.auth.validateToken(session.token), undefined);
    assert.equal(clientAuth.getToken(), undefined);
    assert.deepEqual(await client.call({ url: `${rig.baseUrl}/whoami`, data: {} }),
      { authenticated: false, uid: null });
  } finally {
    await rig.close();
  }
});

test("close(): forgets token and credentials; whoami reports unauthenticated", async () => {
  const rig = await startRig();
  const { client, clientAuth } = makeClient(rig);
  try {
    await clientAuth.login({ uid: "user1", pwd: "correct-horse" });
    clientAuth.close();
    assert.equal(clientAuth.isAuthenticated(), false);
    assert.equal(clientAuth.authState, AuthState.Closed);
    assert.deepEqual(await client.call({ url: `${rig.baseUrl}/whoami`, data: {} }),
      { authenticated: false, uid: null });
  } finally {
    await rig.close();
  }
});
