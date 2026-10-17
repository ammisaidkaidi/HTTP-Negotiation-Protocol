# HTTP Negotiation Protocol — Workflow Design

**Audience:** developer · **Detail level:** detailed · **Format:** Mermaid flowchart

## 1. Entry points

| Entry point | Where | Role |
|---|---|---|
| `client.call({ url, data, params?, headers?, signal?, maxRounds? })` | `src/client/NegotiationClient.ts` | Starts one logical call from application code |
| `server.requestHandler()` / `server.attach(httpServer)` / `server.handleRequest(req, res)` | `src/server/NegotiationServer.ts` | Your HTTP server hands every request to the protocol |
| `payments`/providers POST to a generated `callbackUrl` | `handleExternalCallback()` | External webhook entry point |
| Route handler `server.handle(path, handler)` | your code | Business logic; runs suspended across rounds |
| Client services `client.use({ name: fn })` | your code | Functions the server can ask the client to execute |

## 2. Main steps, functions, and modules

- **Client** (`NegotiationClient`): `call()` → round loop → `send()` (plugin chain + fetch) → `executeAction()` per asked service.
- **Shared** (`src/common/negotiations.ts`): wire types (`NegotiationResponse`, `ClientAction`, `ActionResult`), plugin types, `handledResult()`, `haltRequest()`, contract helpers (`defineContract`, `svc`/`act`).
- **Crypto** (`src/common/webCrypto.ts`): `sha256Hex` token hashing, `randomUuid`, `constantTimeEqual` (Web Crypto only).
- **Server** (`NegotiationServer`): `dispatch()` routes each HTTP request → `handleInitialRequest()` (creates a job) / `handleResume()` (continues a job) / `handleExternalCallback()`; the route handler suspends inside `requestClientActions()` (ask), `callback()` (external wait), and finishes via `end()` / `finishWithError()`.

## 3–6. Workflow diagram (data flow, decisions, external calls, outputs)

```mermaid
flowchart TD
    subgraph APP["Application code"]
        A1["client.call(url, data) — ENTRY POINT"]
        A2["client services: getLocation, getName, ... (your functions)"]
        A3["route handler (your business logic)"]
    end

    subgraph CLIENT["NegotiationClient (src/client)"]
        B1["send(): ClientPlugin.onRequest chain"]
        B2{"onRequest returns false / throws / haltRequest()?"}
        B3["fetch POST (initial request)"]
        B4["validate protocol envelope"]
        B5{"response.done ?"}
        B6["executeAction() x N in parallel (Promise.all)"]
        B7{"service registered?"}
        B8["ActionResult ok:false SERVICE_NOT_FOUND / timeout"]
        B9["send() resume: POST /__negotiation/resume { jobId, round, resumeToken, results }"]
        B10["call() resolves with final result — OUTPUT"]
        B11["call() rejects (coded Error) — OUTPUT"]
    end

    subgraph SERVER["NegotiationServer (src/server) — your HTTP server via requestHandler()/attach()"]
        C1["dispatch(req, res) — ENTRY POINT"]
        C2{"preHandler claims request?"}
        C3["your raw HTTP handler runs (setPreHandler)"]
        C4{"path is /__negotiation/resume ?"}
        C5["handleResume(): find job, verify resume-token hash, round, callbackIDs"]
        C6{"token / round / results valid?"}
        C7["HTTP 400/403/404/409 error"]
        C8["wake suspended handler with results"]
        C9{"path is a callback path?"}
        C10["handleExternalCallback(): verify callback token"]
        C11["settle the waiting server.callback() promise (duplicates acked, ignored)"]
        C12["handleInitialRequest(): parse JSON body"]
        C13{"route exists? / jobs below maxJobs?"}
        C14["HTTP 404 NOT_FOUND / 503 TOO_MANY_JOBS"]
        C15["create JobContext (jobs Map), start jobTimeout timer"]
        C16["ServerPlugin.onCallStart chain"]
        C17{"plugin returned handledResult(result)?"}
        C18["end(result): skip handler"]
        C19{"plugin threw?"}
        C20["route handler runs (AsyncLocalStorage job context)"]
        C21{"handler's next step"}
        C22["requestClientActions(): build round, rotate resume token, onRound plugins, send done:false + actions, SUSPEND handler"]
        C23["server.callback(): run action with callbackUrl, SUSPEND until provider POSTs or callbackTimeoutMs"]
        C24["end(result) / handler return value"]
        C25["finishWithError(error)"]
        C26["onCallEnd plugins / onCallError plugins (throws only reported via onError)"]
        C27["reply done:true { result } or { error } — HTTP 200"]
        C28["job deleted, expiry timer cleared — SIDE EFFECT (memory only, no DB)"]
    end

    subgraph EXT["External world"]
        D1["client services execute (browser/Node user code)"]
        D2["external provider (payment, carrier...)"]
        D3["provider POSTs result to generated callbackUrl — ENTRY POINT"]
    end

    A1 --> B1
    B1 --> B2
    B2 -- "yes: halt" --> B11
    B2 -- "no" --> B3
    B3 -- "HTTP POST" --> C1
    C1 --> C2
    C2 -- "yes" --> C3
    C2 -- "no" --> C4
    C4 -- "yes" --> C5
    C5 --> C6
    C6 -- "no" --> C7
    C6 -- "yes" --> C8
    C4 -- "no" --> C9
    C9 -- "yes" --> C10
    C10 --> D3
    D3 --> C11
    C11 --> C23
    C9 -- "no" --> C12
    C12 --> C13
    C13 -- "no" --> C14
    C13 -- "yes" --> C15
    C15 --> C16
    C16 --> C17
    C17 -- "yes" --> C18
    C17 -- "no" --> C19
    C19 -- "yes" --> C25
    C19 -- "no" --> C20
    A3 -. "handler body" .-> C20
    C20 --> C21
    C21 -- "ask / asks / run client services" --> C22
    C21 -- "callback() external wait" --> C23
    C21 -- "return value" --> C24
    C22 -- "done:false + actions" --> B4
    B4 --> B5
    B5 -- "no: more rounds" --> B6
    B6 --> A2
    A2 --> D1
    D1 --> B7
    B7 -- "no" --> B8
    B7 -- "yes" --> B9
    B8 --> B9
    B9 -- "HTTP POST resume" --> C1
    C8 --> C20
    C23 -- "action receives callbackUrl" --> D2
    D2 -. "later, async" .-> D3
    C23 -- "provider result" --> C20
    C18 --> C27
    C24 --> C27
    C25 --> C26
    C26 --> C27
    C27 --> C28
    C27 -- "final envelope" --> B4
    B5 -- "yes, result" --> B10
    B5 -- "yes, error payload" --> B11
```

## 7. Each step in simple language

1. **You call `client.call()`.** One call from your code may internally become many HTTP requests; you only ever await the final answer.
2. **Client plugins get a say first.** Your `onRequest` plugins run before every fetch. One of them may stop the request entirely (`return false`, throw, `haltRequest()`) — then `call()` rejects with `REQUEST_HALTED` and nothing is sent.
3. **The first HTTP request reaches your server.** `dispatch()` first offers the request to a raw `setPreHandler` (if you set one), then checks: is this a *resume* (continuation), a *provider callback*, or a *new call*?
4. **New call → a "job" is born.** The server creates a job object in memory (with an overall expiry timer), runs `onCallStart` plugins, and starts your route handler. A plugin can answer the whole call itself via `handledResult(...)`, or fail it by throwing.
5. **Your handler runs "in slow motion".** When it awaits `server.ask...`, the server replies `done: false` plus a list of actions, and *freezes* the handler mid-function. Nothing about the HTTP connection is kept open.
6. **The client does the asked work.** All actions of a round run in parallel. Unknown services, timeouts, and failures become `ok: false` results instead of crashes.
7. **The client sends the results back** to `/__negotiation/resume` with a one-time resume token (rotated every round, stored server-side only as a SHA-256 hash). Bad token/round/results are rejected (403/409/400); good results *wake the handler exactly where it froze*.
8. **External waits work the same way.** `server.callback()` hands a provider a generated `callbackUrl` and freezes until the provider POSTs (or `callbackTimeoutMs` passes). Duplicate provider POSTs are acknowledged but ignored.
9. **Finishing.** When the handler returns (or calls `server.end(result)`), the server sends `done: true` with the result, runs `onCallEnd`, deletes the job, and `client.call()` resolves. If anything threw, the same path sends `done: true` with an `error` payload, `onCallError` runs, and `client.call()` rejects with a coded error.
10. **Side effects are memory-only.** Jobs live in one process, bounded by `maxJobs`, `requestTimeoutMs` (per round), and `jobTimeoutMs` (whole call). Nothing is written to a database; restarting the server loses in-flight jobs.

## 8. Error exits (summary)

| Situation | Wire result | `client.call()` |
|---|---|---|
| Client plugin halts | *(nothing sent)* | rejects `REQUEST_HALTED` |
| Unknown route / too many jobs | HTTP 404 / 503 | rejects with that HTTP error |
| Plugin/handler throws | `done:true` + `{ error }` (HTTP 200) | rejects with `error.code` |
| Bad resume token/round | HTTP 403 / 409 | rejects (job is dead) |
| Round exceeds `requestTimeoutMs` | job fails server-side | rejects on next response / timeout |
| Job exceeds `jobTimeoutMs` | job expired (`JOB_EXPIRED`) | rejects |
| Client exceeds `maxRounds` | — | rejects `MAX_ROUNDS_EXCEEDED` |
