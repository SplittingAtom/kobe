import { deriveRunTokenKey } from "@kobe/protocol/node";
import type { GatewayOptions } from "../gateway.js";

/** Run token settings for harnesses whose sandboxes carry no run token: enforcement off. */
export function noRunTokens(): GatewayOptions["runTokens"] {
  return {
    key: deriveRunTokenKey(new TextEncoder().encode("t".repeat(40))),
    isActive: async () => false,
    require: false,
  };
}
