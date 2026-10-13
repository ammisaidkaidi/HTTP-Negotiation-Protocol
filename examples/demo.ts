import {
  MemoryRequestStore,
  NegotiationClient,
  NegotiationServer,
  PostgresRequestStore,
  type ClientPlugin,
  type HttpPluginRequest,
  type HttpPluginResponse,
} from "../src/protocol.js";

const port = Number(process.env.PORT ?? 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`;
const store = process.env.DATABASE_URL
  ? new PostgresRequestStore(process.env.DATABASE_URL)
  : new MemoryRequestStore();

interface Location {
  area: string;
}

interface Preferences {
  preferredPeriod: "morning" | "afternoon";
  fragileHandling: boolean;
}

interface Slot {
  id: string;
  label: string;
}

interface CarrierQuote {
  eventId: string;
  quoteId: string;
  feeDzd: number;
  etaMinutes: number;
}

const server = new NegotiationServer({
  publicBaseUrl,
  store,
  requestTimeoutMs: 120_000,
});

server.use({
  "delivery.getAvailableSlots": async ({ period }) => {
    const slots: Slot[] = period === "morning"
      ? [
          { id: "slot_09_11", label: "09:00–11:00" },
          { id: "slot_11_13", label: "11:00–13:00" },
        ]
      : [
          { id: "slot_14_16", label: "14:00–16:00" },
          { id: "slot_16_18", label: "16:00–18:00" },
        ];
    console.log("[Server action] available slots:", slots);
    return slots;
  },

  // A real implementation would send callbackUrl to the carrier provider.
  // Here, a timer simulates a provider calling that URL asynchronously.
  "carrier.requestQuote": async ({ orderId, area, slotId, callbackUrl }) => {
    console.log("[Server action] requesting quote:", { orderId, area, slotId });
    setTimeout(() => {
      void fetch(String(callbackUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: `event_${orderId}`,
          quoteId: "QUOTE-77",
          feeDzd: 750,
          etaMinutes: 85,
        } satisfies CarrierQuote),
      }).then(async (response) => {
        if (!response.ok) {
          console.error("Simulated carrier callback failed:", await response.text());
        }
      }).catch((error: unknown) => {
        console.error("Simulated carrier callback failed:", error);
      });
    }, 150);
    return { accepted: true };
  },
});

server.handle("/delivery/estimate", async (request) => {
  const input = request.data as { orderId?: string; deliveryArea?: string } | null;
  if (!input?.orderId || !input.deliveryArea) {
    throw new Error("orderId and deliveryArea are required");
  }

  // Both client services execute in parallel in one negotiation round.
  // The fallback property keeps a non-critical service failure out of the main flow.
  const [locationValue, preferencesValue] = await server.requireMany([
    {
      name: "getCurrentLocation",
      data: {},
      fallback: null,
    },
    {
      name: "getDeliveryPreferences",
      data: {},
      fallback: { preferredPeriod: "afternoon", fragileHandling: false } satisfies Preferences,
    },
  ]);

  const location = locationValue as Location | null;
  const preferences = preferencesValue as Preferences;
  const area = location?.area ?? input.deliveryArea;

  // A server-side action is called with normal await: no callback IDs involved.
  const slots = await server.call<Slot[]>("delivery.getAvailableSlots", {
    area,
    period: preferences.preferredPeriod,
  });

  // One service call; Server creates and tracks the callback ID internally.
  const selected = await server.require<{ slotId: string }>("selectDeliverySlot", {
    orderId: input.orderId,
    slots,
    fragileHandling: preferences.fragileHandling,
  });

  const selectedSlot = slots.find((slot) => slot.id === selected.slotId);
  if (!selectedSlot) throw new Error("The client selected an invalid delivery slot");

  // One high-level call hides jobId, callbackID, token, callback URL registration,
  // and waiting for the external provider callback.
  const quote = await server.callback<CarrierQuote>("carrier.requestQuote", {
    orderId: input.orderId,
    area,
    slotId: selectedSlot.id,
    fragileHandling: preferences.fragileHandling,
  });

  // end(result) both returns the final payload and persists the request/response.
  await server.end({
    orderId: input.orderId,
    delivery: {
      area,
      locationSource: location ? "gps" : "deliveryArea",
      slotId: selectedSlot.id,
      slotLabel: selectedSlot.label,
    },
    shipping: {
      quoteId: quote.quoteId,
      feeDzd: quote.feeDzd,
      etaMinutes: quote.etaMinutes,
    },
  });
});

async function main(): Promise<void> {
  const client = new NegotiationClient();
  const plugin: ClientPlugin = {
    onRequest: async (request: HttpPluginRequest) => {
      console.log(`[Plugin] ${request.phase.toUpperCase()} ${request.url}`);
      return request;
    },
    onResponse: async (_body: unknown, response: HttpPluginResponse) => {
      console.log(`[Plugin] HTTP ${response.status} (${response.phase})`);
    },
  };

  // `.use(plugin).use(services)` keeps the public setup simple.
  client.use(plugin).use({
    getCurrentLocation: async () => {
      // Simulate a user denying GPS permission; the declared fallback is used.
      const error = new Error("Location permission denied") as Error & { code: string };
      error.code = "PERMISSION_DENIED";
      throw error;
    },
    getDeliveryPreferences: async (): Promise<Preferences> => ({
      preferredPeriod: "afternoon",
      fragileHandling: true,
    }),
    selectDeliverySlot: async ({ slots }: { slots: Slot[] }) => ({
      slotId: slots.find((slot) => slot.id === "slot_16_18")?.id ?? "",
    }),
  });

  await server.listen(port);
  console.log(`Negotiation demo listening on ${publicBaseUrl}`);
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL is not set: final records are stored in memory only.");
  }

  try {
    const result = await client.call({
      url: `${publicBaseUrl}/delivery/estimate`,
      params: { locale: "en" },
      data: { orderId: "ORD-204", deliveryArea: "Ghardaia-Centre" },
    });
    console.log("\nFINAL RESULT\n", JSON.stringify(result, null, 2));
  } finally {
    await server.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
