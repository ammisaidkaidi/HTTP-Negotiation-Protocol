import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import {
  NegotiationServer,
  ServerAuthManager,
} from "../src/server/index.js";
import ts from "typescript";

// Server startup: reset this process's time zone to UTC+0 (universal
// time). The auth negotiation itself compares UTC epoch milliseconds,
// and all demo timestamps below are rendered as ISO UTC strings.
process.env.TZ = "UTC";

/**
 * Web demo for the library (see demo/index.html):
 *
 * - One HTTP server serves the web page, the auth endpoint (/auth), and
 *   the negotiation routes, via ServerAuthManager(negotiationServer, ...)
 *   + attach().
 * - The browser loads the actual client library modules from
 *   /browser-lib/* (TypeScript sources transpiled on demand). Its
 *   Authenticate button constructs a NegotiationClient and a
 *   ClientAuthManager in the page and calls authenticate() directly;
 *   there is deliberately no /api/auth fetch endpoint.
 */

const port = Number(process.env.PORT ?? 3000);
const internalBaseUrl = `http://127.0.0.1:${port}`;

const users: Record<string, string> = {
  user1: "correct-horse",
};

interface EventEntry {
  time: string;
  scope: string;
  message: string;
}

const events: EventEntry[] = [];
function logEvent(scope: string, message: string): void {
  events.push({ time: new Date().toISOString(), scope, message });
  if (events.length > 60) events.shift();
  console.log(`[${scope}] ${message}`);
}

// ---------------------------------------------------------------------------
// Library setup
// ---------------------------------------------------------------------------

const negotiationServer = new NegotiationServer({
  requestTimeoutMs: 15_000,
  // The simulated carrier (see carrier.requestQuote below) calls back from
  // this same process, so generated callback URLs must target the internal
  // listener — not the browser-facing origin (e.g. the hosted preview URL),
  // which this process cannot fetch back, leaving callback() to time out.
  // Deployments with a genuinely external provider should set
  // PUBLIC_BASE_URL to a publicly reachable HTTPS URL instead.
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? internalBaseUrl,
});

negotiationServer.use({
  "delivery.getAvailableSlots": async ({ period }: { period: string }) => {
    const slots = period === "morning"
      ? [{ id: "slot_09_11", label: "09:00-11:00" }, { id: "slot_11_13", label: "11:00-13:00" }]
      : [{ id: "slot_14_16", label: "14:00-16:00" }, { id: "slot_16_18", label: "16:00-18:00" }];
    logEvent("server-action", `delivery.getAvailableSlots(period=${period}) -> ${slots.map((s) => s.id).join(", ")}`);
    return slots;
  },
  // Simulates an external carrier calling the generated callback URL back.
  "carrier.requestQuote": async ({ orderId, callbackUrl }: { orderId: string; callbackUrl: string }) => {
    logEvent("server-action", `carrier.requestQuote(order=${orderId}) -> provider will call back`);
    setTimeout(() => {
      void fetch(callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId: `event_${orderId}`, quoteId: "QUOTE-77", feeDzd: 750, etaMinutes: 85 }),
      }).catch((error: unknown) => {
        const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
        logEvent("carrier", `callback failed: ${error instanceof Error ? error.message : String(error)}${cause}`);
      });
    }, 150);
    return { accepted: true };
  },
});

negotiationServer.handle("/whoami", async (request) => {
  const header = request.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  const entry = authServer.validateToken(token);
  return { authenticated: entry !== undefined, uid: entry?.uid ?? null };
});

negotiationServer.handle("/delivery/estimate", async (request) => {
  const input = request.data as { orderId?: string; deliveryArea?: string } | null;
  if (!input?.orderId || !input.deliveryArea) {
    throw new Error("orderId and deliveryArea are required");
  }

  const asks = negotiationServer.asks();
  asks
    .getCurrentLocation({}, { fallback: null })
    .getDeliveryPreferences({}, { fallback: { preferredPeriod: "afternoon", fragileHandling: false } });
  const [locationValue, preferencesValue] = await asks.done();
  const location = locationValue as { area: string } | null;
  const preferences = preferencesValue as { preferredPeriod: string; fragileHandling: boolean };
  const area = location?.area ?? input.deliveryArea;

  const slots = await negotiationServer.run.delivery.getAvailableSlots({
    area,
    period: preferences.preferredPeriod,
  }) as { id: string; label: string }[];

  const selected = await negotiationServer.ask.selectDeliverySlot({
    orderId: input.orderId,
    slots,
    fragileHandling: preferences.fragileHandling,
  }) as { slotId: string };
  const selectedSlot = slots.find((slot) => slot.id === selected.slotId);
  if (!selectedSlot) throw new Error("The client selected an invalid delivery slot");

  const quote = await negotiationServer.callback<{ quoteId: string; feeDzd: number; etaMinutes: number }>(
    "carrier.requestQuote",
    { orderId: input.orderId, area, slotId: selectedSlot.id, fragileHandling: preferences.fragileHandling },
  );

  return {
    orderId: input.orderId,
    delivery: {
      area,
      locationSource: location ? "gps" : "deliveryArea",
      slotId: selectedSlot.id,
      slotLabel: selectedSlot.label,
    },
    shipping: { quoteId: quote.quoteId, feeDzd: quote.feeDzd, etaMinutes: quote.etaMinutes },
  };
});

const authServer = new ServerAuthManager(negotiationServer, {
  maxClockSkewMs: 20_000,
  timeBucketMs: 20_000,
  getPassword: async (uid) => users[uid],
  onError: (error, info) => logEvent("auth", `FAILED during ${info.phase}: ${error.message}`),
});

// ---------------------------------------------------------------------------
// Web server: page + /api/* + (/auth and negotiation routes via the library)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(encoded));
  res.end(encoded);
}

function state(): Record<string, unknown> {
  return {
    registry: [...authServer.registry.values()].map((entry) => ({
      uid: entry.uid,
      token: `${entry.token.slice(0, 10)}...`,
      acknowledged: entry.acknowledged,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    })),
    activeJobs: negotiationServer.getActiveCallCount(),
    serverTimeUtc: authServer.universalTime,
    serverStartedAtUtc: authServer.startedAtUtc,
    events,
  };
}

/**
 * Serve the real client-side library sources to the browser. Only the
 * client/common modules are exposed; TypeScript's transpile-only output
 * preserves their relative .js import specifiers, which this same route
 * resolves on the next request. ClientAuthManager's auth crypto uses
 * Web Crypto, so no Node.js module reaches the browser.
 */
async function sendBrowserModule(res: ServerResponse, modulePath: string): Promise<void> {
  const relative = modulePath.slice("/browser-lib/".length);
  const parts = relative.split("/");
  const allowedRoot = parts[0] === "client" || parts[0] === "common";
  if (
    !relative.endsWith(".js") ||
    !allowedRoot ||
    parts.some((part) => !part || part.startsWith("."))
  ) {
    sendJson(res, 404, { ok: false, message: "Browser module not found" });
    return;
  }
  try {
    const sourceUrl = new URL(`../src/${relative.slice(0, -3)}.ts`, import.meta.url);
    const source = await readFile(sourceUrl, "utf8");
    const output = ts.transpileModule(source, {
      fileName: sourceUrl.pathname,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    res.statusCode = 200;
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(`${output}\n//# sourceURL=${modulePath}`);
  } catch {
    sendJson(res, 404, { ok: false, message: "Browser module not found" });
  }
}

const http = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", internalBaseUrl);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, state());
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/browser-lib/")) {
        await sendBrowserModule(res, url.pathname);
        return;
      }

      // Everything else belongs to the library: /auth + negotiation routes.
      authServer.requestHandler()(req, res);
    } catch (error) {
      logEvent("api", `error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.writableEnded) {
        sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
  })();
});

// Combined hosting: auth manager and negotiation server share this HTTP server.
authServer.attach(http);
negotiationServer.attach(http);

await new Promise<void>((resolve) => http.listen(port, "0.0.0.0", resolve));
logEvent("time", `server time reset to universal time (UTC+0) at startup: ${authServer.startedAtUtc}`);
logEvent("web", `demo listening on http://127.0.0.1:${port} (page + /auth + negotiation routes)`);

process.on("SIGTERM", () => {
  void authServer.close().finally(() => process.exit(0));
});
