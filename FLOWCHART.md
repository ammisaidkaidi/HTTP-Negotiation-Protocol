# Full Mermaid Flowchart — core library only

Scope: `src/client`, `src/common`, `src/server` only (no examples, no
demo, no auth-plugin). Entry point: `NegotiationClient.call()` / `send()`.

```mermaid
flowchart TD
    %% ================= CLIENT =================
    subgraph CLIENT["src/client — NegotiationClient"]
        NC1["NegotiationClient.call(url, data)<br/>ENTRY POINT"]
        NC2["send(url, body, phase)<br/>ClientPlugin.onRequest chain (awaited, in order)"]
        NC3{"onRequest returns false,<br/>throws, or haltRequest() ?"}
        RHE["RequestHaltedError<br/>(class · extends Error · code REQUEST_HALTED)"]
        NCERR["ClientPlugin.onError chain<br/>(transport / HTTP failures + halts)"]
        NC4["fetch POST<br/>AbortSignal.any(requestTimeoutMs, call signal)"]
        NC5["read body · size check (maxResponseBytes) · JSON.parse"]
        NC6["ClientPlugin.onResponse chain<br/>(may replace body)"]
        NC7["call(): validate envelope<br/>protocol=1 · done boolean · round advances"]
        NC8{"done ?"}
        NC9{"envelope has error ?"}
        NC10["executeAction(action) × N<br/>Promise.all over the round's actions"]
        NC11{"service registered<br/>in services Map?"}
        NC12["run service(data) raced against<br/>serviceTimeoutMs + AbortSignal"]
        NC13{"service ok?"}
        NC14["ActionResult { callbackID, ok:true, result }"]
        NC15["ActionResult { callbackID, ok:false,<br/>error SERVICE_NOT_FOUND / SERVICE_TIMEOUT / thrown }"]
        NC16["rounds > maxRounds?"}
        NC17["Error MAX_ROUNDS_EXCEEDED"]
        NC18["send() — resume round<br/>POST resumeUrl { jobId, round, resumeToken, results }"]
        OUT1["call() RESOLVES with result — FINAL OUTPUT"]
        OUT2["call() REJECTS (coded Error) — FINAL OUTPUT"]
    end

    %% ================= COMMON =================
    subgraph COMMON["src/common"]
        TYP["negotiations.ts — wire types & helpers<br/>ClientCallRequest · ServerRequest · ClientAction<br/>ActionResult · NegotiationResponse · handledResult()<br/>ClientPlugin · ServerPlugin · contract: defineContract/svc/act<br/>errorPayload() · isObjectRecord() · toError()"]
        WC["webCrypto.ts — Web Crypto only<br/>sha256Hex · randomUuid · randomInt<br/>constantTimeEqual · subtleCrypto()"]
    end

    %% ================= SERVER =================
    subgraph SERVER["src/server — NegotiationServer"]
        NS1["handleRequest() / dispatch(req, res)<br/>from YOUR http server (requestHandler() · attach())"]
        NS2{"setPreHandler set<br/>and claims request?"}
        NS3["pre-handler's raw HTTP response"]
        NS4{"method not POST?"}
        NS5["HTTP 405 METHOD_NOT_ALLOWED"]
        NS6{"path = /__negotiation/resume ?"}
        NS7["handleResume(): jobs.get(jobId)"]
        NS8{"job exists, resume-token hash<br/>matches (constantTimeEqual)?"}
        NS9["HTTP 404 UNKNOWN_JOB / 403 INVALID_RESUME_TOKEN"]
        NS10{"pending round matches AND<br/>results cover every callbackID exactly once?"}
        NS11["HTTP 409 UNEXPECTED_ROUND / 400 INVALID_RESULTS"]
        NS12["normalize results → ActionResult[]<br/>resolve(pending) — HANDLER WAKES"]
        NS13{"callback path? (callbackPaths set)"}
        NS14["handleExternalCallback(): read JSON"]
        NS15{"callback id + token hash valid?"}
        NS16["HTTP 403 INVALID_CALLBACK"]
        NS17{"already received (duplicate)?"}
        NS18["HTTP 200 { ok:true, duplicate:true } — no re-settle"]
        NS19["settle ExternalCallback.result Deferred<br/>HTTP 200 { ok:true, received:true }"]
        NS20["handleInitialRequest(): readJson(maxBodyBytes)"]
        NS21{"route registered?"}
        NS22["HTTP 404 NOT_FOUND"]
        NS23{"jobs.size below maxJobs?"}
        NS24["HTTP 503 TOO_MANY_JOBS"]
        NS25["create JobContext { jobId, resumeTokenHash,<br/>request, round:0 } → jobs Map"]
        NS26["jobTimeoutMs expiry timer (unref)<br/>→ expireJob() on timeout"]
        NS27["storage.run(JobContext) — AsyncLocalStorage"]
        NS28["runJobStartPlugins(): ServerPlugin<br/>onCallStart → onNegotiationStart → onJobStart (aliases)"]
        NS29{"any start hook returned<br/>handledResult(result)?"}
        NS30{"any start hook threw?"}
        NS31["route handler runs<br/>(requireContext() via AsyncLocalStorage)"]
        NS32{"handler awaits"}
        NS33["requestService() / require() [deprecated]<br/>asks() / runs() builders · call() server actions"]
        NS34["requestClientActions(actions): round++<br/>pending = Deferred + expected callbackIDs<br/>rotate resume token (randomUuid → sha256Hex)"]
        NS35["runPlugins: onRound hooks"]
        NS36["sendProtocolResponse: done:false<br/>{ round, actions, resumeUrl, resumeToken }<br/>HANDLER SUSPENDED on Deferred"]
        NS37["await Deferred — requestTimeoutMs guard"]
        NS38{"Deferred rejected (timeout)?"}
        NS39["round timeout Error → handler's await throws"]
        SAI["ServerActionInvocation (class)<br/>implements PromiseLike · then() → execute()<br/>runs registered action with job request context"]
        NS40["callback(): createCallback()<br/>generate callbackId+token (hash stored)<br/>execute action with callbackUrl · await Deferred"]
        NS41["await callback Deferred — callbackTimeoutMs guard"]
        NS42["action returns value"]
        NS43["respond(request, result) / handler return value"]
        NS44["end(result): resultSet = true"]
        NS45["finishWithError(error)"]
        NS46["runPluginsSafely: onCallEnd hooks<br/>(payload: ServerPluginCallResult)"]
        NS47["runPluginsSafely: onCallError hooks<br/>(payload: ServerPluginCallError)"]
        NS48["build final envelope done:true<br/>{ result } or { error }"]
        NS49["sendJson(currentResponse, 200, envelope)<br/>waitForResponseEnd()"]
        NS50["cleanup: clearTimeout(expiry) · jobs.delete(jobId)<br/>ended = true — SIDE EFFECT: memory only"]
    end

    EXT["external provider<br/>server action hands it callbackUrl"]

    %% ============ CLIENT FLOW ============
    NC1 --> NC2
    NC2 --> NC3
    NC3 -->|"halt"| RHE
    RHE --> NCERR
    NC3 -->|"continue / replaced request"| NC4
    NC4 -->|"transport error / abort / timeout"| NCERR
    NCERR --> OUT2
    NC4 --> NS1
    NC4 --> NC5
    NC5 --> NC6
    NC6 --> NC7
    NC7 -->|"invalid envelope"| OUT2
    NC7 --> NC8
    NC8 -->|"yes"| NC9
    NC9 -->|"yes"| OUT2
    NC9 -->|"no — final result"| OUT1
    NC8 -->|"no — round"| NC16
    NC16 -->|"yes"| NC17
    NC17 --> OUT2
    NC16 -->|"no"| NC10
    NC10 --> NC11
    NC11 -->|"no"| NC15
    NC11 -->|"yes"| NC12
    NC12 --> NC13
    NC13 -->|"ok"| NC14
    NC13 -->|"error / timeout"| NC15
    NC14 --> NC18
    NC15 --> NC18
    NC18 --> NC2

    %% ============ SERVER DISPATCH ============
    NS1 --> NS2
    NS2 -->|"true"| NS3
    NS2 -->|"false / none"| NS4
    NS4 -->|"yes"| NS5
    NS4 -->|"POST"| NS6
    NS6 -->|"yes"| NS7
    NS7 --> NS8
    NS8 -->|"no"| NS9
    NS8 -->|"yes"| NS10
    NS10 -->|"no"| NS11
    NS10 -->|"yes"| NS12
    NS6 -->|"no"| NS13
    NS13 -->|"yes"| NS14
    NS14 --> NS15
    NS15 -->|"no"| NS16
    NS15 -->|"yes"| NS17
    NS17 -->|"yes"| NS18
    NS17 -->|"no"| NS19
    NS13 -->|"no"| NS20
    NS20 --> NS21
    NS21 -->|"no"| NS22
    NS21 -->|"yes"| NS23
    NS23 -->|"no"| NS24
    NS23 -->|"yes"| NS25

    %% ============ JOB LIFECYCLE ============
    NS25 --> NS27
    NS27 --> NS28
    NS28 --> NS29
    NS29 -->|"yes — skip handler"| NS44
    NS29 -->|"no"| NS30
    NS30 -->|"yes"| NS45
    NS30 -->|"no"| NS31
    NS31 --> NS32
    NS32 -->|"ask client services"| NS33
    NS32 -->|"server action"| SAI
    SAI --> NS42
    NS42 --> NS31
    NS32 -->|"external callback"| NS40
    NS32 -->|"end() / return"| NS43
    NS43 --> NS44
    NS33 --> NS34
    NS34 --> NS35
    NS35 --> NS36
    NS36 -->|"envelope to client"| NC5
    NS36 --> NS37
    NS12 -->|"results"| NS37
    NS37 --> NS38
    NS38 -->|"yes"| NS39
    NS39 --> NS31
    NS38 -->|"no — results in"| NS31
    NS40 --> EXT
    EXT -.->|"POST callbackUrl (later)"| NS1
    NS19 -->|"value"| NS31
    NS40 --> NS41
    NS41 -->|"timeout"| NS39
    NS41 -->|"settled"| NS31
    NS26 -.->|"fires while suspended"| NS45
    NS44 --> NS46
    NS45 --> NS47
    NS46 --> NS48
    NS47 --> NS48
    NS48 --> NS49
    NS49 --> NC5
    NS49 --> NS50

    %% ============ SHARED MODULE USE ============
    NC1 -.->|"types"| TYP
    NS33 -.->|"types"| TYP
    NS25 -.->|"randomUuid + sha256Hex"| WC
    NS8 -.->|"constantTimeEqual"| WC
    NS34 -.->|"rotate token"| WC
```
