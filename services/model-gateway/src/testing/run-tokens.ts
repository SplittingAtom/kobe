import { generateSessionKeyPair } from "@kobe/session-token";
import type { GatewayOptions } from "../gateway.js";

/** Run token settings for harnesses whose sandboxes carry no run token: enforcement off. */
export function noRunTokens(): GatewayOptions["runTokens"] {
  return {
    keys: generateSessionKeyPair().verify,
    isActive: async () => false,
    require: false,
  };
}
