# Web Demo

A web interface demo for the library: the browser itself runs the
`NegotiationClient` and `ClientAuthManager`; the Node process only hosts
the page, the server-side negotiation routes, and the auth route.

## Run

```bash
npm install
npm run demo:web        # http://127.0.0.1:3000
```

Then in the page:

1. **Authenticate** — the button constructs
   `new ClientAuthManager(negotiationClient, { authUrl, uid, password })`
   in the browser and calls `clientAuth.authenticate()`. It does **not**
   call `fetch("/api/auth")`; there is no such endpoint. The auth
   negotiation runs directly between that browser `ClientAuthManager`
   and the server's `ServerAuthManager`. Try a wrong password to see it fail.
   The **Auth workflow** panel under the button shows every operation of
   the flow (begin, `auth.time` samples, `auth.getUid`, encrypted
   challenge, solve/validate, token generation, registry save,
   `auth.acceptToken` ack, job end, and later token use/close) and marks
   each step pending → active → done/failed live as the real asks arrive.
2. **Call /whoami** — the same bound browser `NegotiationClient` sends
   the Bearer token automatically; the route validates it against the
   server registry.
3. **Run /delivery/estimate** — one logical `negotiationClient.call()`
   with parallel client services, a server action, a slot selection, and
   an external carrier callback. The browser + server log panels show
   the plugins, services, actions, and auth events live.

## How it is wired

- `demo/server.ts` creates
  `new ServerAuthManager(negotiationServer, { getPassword })`, which
  registers `/auth` on the `NegotiationServer`; both are attached to
  the one HTTP server that also serves this page.
- The page imports the actual client library from
  `/browser-lib/client/index.js`. The demo server transpiles the
  TypeScript sources under `src/client/` and `src/common/` on demand
  and serves them as browser ES modules.
- The client auth crypto uses Web Crypto
  (`src/common/authCrypto.ts` plus `src/common/webCrypto.ts`), so
  `ClientAuthManager` runs in the browser with no Node-specific
  crypto import. Use HTTPS or localhost, where `crypto.subtle` is
  available.
- At startup the demo server resets its process time zone to UTC+0
  and reports universal time (`serverTimeUtc` / `serverStartedAtUtc`,
  ISO 8601 UTC) in `/api/state`; the page shows it in the header.
- Auth timing uses a 20,000 ms window by default: both the accepted
  client/server clock skew and the `time\20000` encryption bucket.
- `/api/state` is only a read-only status endpoint for the registry,
  active jobs, and server log; it contains no authentication or
  negotiation logic.
