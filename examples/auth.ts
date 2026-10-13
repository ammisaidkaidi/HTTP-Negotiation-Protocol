import {
  ClientAuthManager,
  ServerAuthManager,
} from "../src/auth/index.js";

// Demo of the challenge-response auth flow in src/auth/:
//   begin -> time sync (clocks must agree within 50 ms) -> uid ->
//   encrypted challenge (function names + data, key = HKDF(pwd, time\50))
//   -> encrypted answer -> server saves token to its registry, sends it ->
//   ack -> connection closed. After close(), a fresh auth process runs.

const users: Record<string, string> = {
  user1: "correct-horse",
};

async function main(): Promise<void> {
  const port = Number(process.env.AUTH_PORT ?? 4000);
  const server = new ServerAuthManager({
    // Per-user password lookup (could read a DB / secret manager instead).
    getPassword: async (uid) => users[uid],
  });
  await server.listen(port, "127.0.0.1");
  console.log(`Auth server listening on http://127.0.0.1:${port}/auth`);

  const client = new ClientAuthManager({
    authUrl: `http://127.0.0.1:${port}/auth`,
    uid: "user1",
    password: "correct-horse",
  });

  try {
    const session = await client.authenticate();
    console.log("AUTH SUCCESS", {
      uid: session.uid,
      token: `${session.token.slice(0, 8)}...`,
      clockOffsetMs: client.lastClockOffsetMs?.toFixed(2),
      registryEntry: server.validateToken(session.token),
    });

    client.close(); // connection closed: token forgotten
    const fresh = await client.authenticate({ force: true });
    console.log("RE-AUTH AFTER CLOSE", {
      newToken: fresh.token !== session.token,
      uid: fresh.uid,
    });
  } finally {
    client.close();
    await server.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
