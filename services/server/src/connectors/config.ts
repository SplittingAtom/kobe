import { validateCidrs } from "@kobe/address-policy";
import { DEFAULT_ALLOWED_PORTS, resolveAll, type ConnectorUrlPolicy } from "./url-policy.js";

type Env = Readonly<Record<string, string | undefined>>;

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

function cidrs(env: Env, name: string): string[] {
  const values = list(env[name]);
  try {
    validateCidrs(values);
  } catch {
    throw new Error(`Invalid configuration: ${name} must be a comma-separated list of CIDRs`);
  }
  return values;
}

/**
 * The connector URL policy from the same env the MCP proxy reads (chart `mcpProxy.*`), so what the
 * registry accepts is what the proxy will connect to (KOBE-100).
 */
export function loadConnectorUrlPolicy(env: Env): ConnectorUrlPolicy {
  const flag = env.KOBE_MCP_ALLOW_INSECURE_HTTP ?? "false";
  if (flag !== "true" && flag !== "false") {
    throw new Error("Invalid configuration: KOBE_MCP_ALLOW_INSECURE_HTTP must be true or false");
  }
  const ports = list(env.KOBE_MCP_ALLOWED_PORTS).map(Number);
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error("Invalid configuration: KOBE_MCP_ALLOWED_PORTS must be ports (1-65535)");
  }
  return {
    allowHttp: flag === "true",
    allowedPorts: ports.length === 0 ? DEFAULT_ALLOWED_PORTS : ports,
    allowedInternalCidrs: cidrs(env, "KOBE_MCP_ALLOWED_INTERNAL_CIDRS"),
    deniedCidrs: cidrs(env, "KOBE_MCP_DENIED_CIDRS"),
    resolve: resolveAll,
  };
}
