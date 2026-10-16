# Web Demo

A web interface demo for the library: the browser itself runs the
`NegotiationClient`; the Node process only hosts the page and the
server-side negotiation routes.

## Run

```bash
npm install
npm run demo:web        # http://127.0.0.1:3000
```

Then in the page:

1. **Run /delivery/estimate** — one logical `negotiationClient.call()`
   with parallel client services in one round (`asks()`), a server
   action (`run.*`), a slot selection (`ask.*`), and an external
   carrier callback (`server.callback()`). The browser + server log
   panels show the plugins, services, actions, and callback live.

## How it is wired

- `demo/server.ts` creates a `NegotiationServer` with the demo routes
  (`/delivery/estimate`) and a simulated carrier action that calls the
  generated callback URL back; the server is attached to the one HTTP
  server that also serves this page.
- Generated callback URLs target the internal listener
  (`publicBaseUrl`), so the in-process simulated carrier can reach
  them; set `PUBLIC_BASE_URL` for genuinely external providers.
- The page imports the actual client library from
  `/browser-lib/client/index.js`. The demo server transpiles the
  TypeScript sources under `src/client/` and `src/common/` on demand
  and serves them as browser ES modules. Only browser-safe modules
  are exposed, so no Node.js code reaches the browser.
- `/api/state` is only a read-only status endpoint for the active
  call count and the server log; it contains no negotiation logic.
