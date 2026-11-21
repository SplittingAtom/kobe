import type { WireContext } from "../context.js";
import type { DeliveryHost } from "../delivery.js";

/** What the delivery helpers share (KOBE-707): the replica's context and the connection. */
export interface DeliveryEnv {
  readonly ctx: WireContext;
  readonly host: DeliveryHost;
}
