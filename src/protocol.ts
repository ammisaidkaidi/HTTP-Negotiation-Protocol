/**
 * Backwards-compatible barrel: the library was split into common.ts,
 * NegotiationClient.ts, and NegotiationServer.ts for maintainability, but every public
 * name remains importable from "./protocol.js" exactly as before.
 */
export { act, defineAction, defineContract, defineService, svc } from "./common.js";
export type {
  ActionResult,
  ActionSpec,
  AskFor,
  AsksBuilder,
  ClientAction,
  ClientCallRequest,
  ClientPlugin,
  ClientService,
  ClientServiceImplementations,
  ClientServiceProxy,
  ClientServiceRequest,
  ClientServices,
  ContractDefinition,
  EmptyContract,
  HttpPluginRequest,
  HttpPluginResponse,
  JsonRecord,
  NegotiationResponse,
  RequestStore,
  RouteHandler,
  RunFor,
  RunsBuilder,
  ServerAction,
  ServerActionImplementations,
  ServerActionProxy,
  ServerRequest,
  ServiceSpec,
  StoredRequestResponse,
} from "./common.js";
export {
  MemoryRequestStore,
  NegotiationServer,
  PostgresRequestStore,
  Server,
  ServerActionInvocation,
  createServer,
} from "./NegotiationServer.js";
export type { NegotiationServerOptions } from "./NegotiationServer.js";
export { Client, NegotiationClient, createClient } from "./NegotiationClient.js";
export type { NegotiationClientOptions } from "./NegotiationClient.js";
