import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AddressPolicy } from "@kobe/address-policy";

/**
 * Where a registered connector may point (spec D27, D28; KOBE-100). The registry checks what the
 * MCP proxy will enforce again at connect time (`checkUpstreamUrl` + the per-connection address
 * check), so an admin learns at registration that a URL can never work, and a private, link-local
 * or metadata address is never accepted. The proxy remains the enforcement point: a name that
 * later re-resolves elsewhere is still refused there.
 */
export interface ConnectorUrlPolicy {
  /** Dev only (`KOBE_MCP_ALLOW_INSECURE_HTTP`): accept `http://`. */
  readonly allowHttp: boolean;
  readonly allowedPorts: readonly number[];
  /** Internal targets the operator allows (on-premises servers), as CIDRs. */
  readonly allowedInternalCidrs: readonly string[];
  readonly deniedCidrs: readonly string[];
  /** Resolves a host to every address it has; rejects when it does not resolve. */
  readonly resolve: (host: string) => Promise<readonly string[]>;
}

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [443];

export async function resolveAll(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

export type ConnectorUrlFailure =
  | "invalid_url"
  | "https_required"
  | "credentials_in_url"
  | "query_in_url"
  | "port_not_allowed"
  | "address_not_allowed"
  | "host_unresolvable";

export type ConnectorUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: ConnectorUrlFailure; readonly message: string };

const refuse = (code: ConnectorUrlFailure, message: string): ConnectorUrlCheck => ({
  ok: false,
  code,
  message,
});

/** Validates and normalizes a connector URL; the message never echoes the URL (it may hold a key). */
export async function checkConnectorUrl(
  raw: string,
  policy: ConnectorUrlPolicy,
): Promise<ConnectorUrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("invalid_url", "That is not a valid URL.");
  }
  if (url.hash !== "") return refuse("invalid_url", "Remove the #fragment from the URL.");
  if (url.search !== "" || raw.includes("?")) {
    return refuse(
      "query_in_url",
      "Remove the ?query from the URL: credentials belong in per-user grants, not in the registry.",
    );
  }
  const https = url.protocol === "https:";
  if (!https && !(url.protocol === "http:" && policy.allowHttp)) {
    return refuse("https_required", "Connector URLs must use https.");
  }
  if (url.username !== "" || url.password !== "") {
    return refuse(
      "credentials_in_url",
      "Do not put credentials in the URL; auth is set separately.",
    );
  }
  const port = url.port === "" ? (https ? 443 : 80) : Number(url.port);
  if (!policy.allowedPorts.includes(port)) {
    return refuse(
      "port_not_allowed",
      `Port ${port} is not allowed for connectors on this install.`,
    );
  }
  const addresses = new AddressPolicy({
    allowedInternal: policy.allowedInternalCidrs,
    extraDenied: policy.deniedCidrs,
  });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let resolved: readonly string[];
  if (isIP(host) !== 0) {
    resolved = [host];
  } else {
    try {
      resolved = await policy.resolve(host);
    } catch {
      return refuse("host_unresolvable", "That host name does not resolve.");
    }
  }
  if (addresses.checkAll(resolved) !== "allowed") {
    return refuse(
      "address_not_allowed",
      "That address is private, link-local or otherwise not allowed for connectors.",
    );
  }
  return { ok: true, url: url.toString() };
}
