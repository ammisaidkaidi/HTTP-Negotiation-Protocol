export * from "./NegotiationServer.js";
export { handledResult, PublicError } from "../common/negotiations.js";
export type {
  ServerPlugin,
  ServerPluginCall,
  ServerPluginCallError,
  ServerPluginCallResult,
  ServerPluginCallRound,
  ServerPluginHandled,
  // Deprecated aliases (renamed to the ServerPluginCall* types above).
  ServerPluginError,
  ServerPluginJob,
  ServerPluginResult,
  ServerPluginRound,
} from "../common/negotiations.js";
