import { BlockList, isIP } from "node:net";

/**
 * Where Kobe's proxies may connect (spec D27, D28; SSRF and DNS-rebinding protection), shared by the
 * egress proxy (KOBE-38) and the MCP proxy (KOBE-58) so the two lists cannot drift. A proxy
 * resolves a host itself, checks **every** address the name resolves to, and connects only to an
 * address it checked, so a name that later re-resolves elsewhere never reaches anything new.
 *
 * Refused unless explicitly allowed as an internal target (`allowedInternal`): every non-global
 * range below (RFC 1918, loopback, link-local incl. the 169.254.169.254 metadata endpoint, CGNAT,
 * multicast, reserved, documentation, benchmarking, IPv6 ULA/link-local/site-local, and the
 * IPv4-embedding IPv6 ranges, which could smuggle an internal IPv4 address), plus the cluster's own
 * pod and Service CIDRs when they are not private (`extraDenied`).
 */
export const DEFAULT_DENIED_CIDRS: readonly string[] = [
  // IPv4
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  // IPv6
  "::/96", // IPv4-compatible (deprecated): embeds an IPv4 address
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:20::/28", // ORCHIDv2 (RFC 7343): not routable
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20", // documentation (RFC 9637)
  "5f00::/16", // SRv6 SIDs (RFC 9602): not global unicast
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

/**
 * Never reachable through an internal target (EA4, KOBE-603), even when the operator lists a range
 * that covers them: unspecified, loopback, link-local (incl. the 169.254.169.254 metadata endpoint
 * and AWS's IPv6 one, fd00:ec2::254), Alibaba's metadata address, multicast and broadcast, and the
 * IPv6 ranges that embed an IPv4 address (an internal target is matched per family, so an embedded
 * loopback or metadata address must not slip through an IPv6 target).
 */
export const ALWAYS_DENIED_CIDRS: readonly string[] = [
  // IPv4
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "100.100.100.200/32",
  "224.0.0.0/4",
  "255.255.255.255/32",
  // IPv6
  "::/96", // unspecified, loopback and IPv4-compatible
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "2002::/16",
  "fd00:ec2::254/128",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

export interface AddressPolicyOptions {
  /**
   * Internal targets an operator explicitly allows for every allowlisted domain (the broader,
   * install-wide option; still subject to the domain allowlist).
   */
  readonly allowedInternal?: readonly string[];
  /**
   * Internal targets reachable only by hosts whose allowlist pattern is marked internal (EA4: the
   * cluster ingress). Addresses in `ALWAYS_DENIED_CIDRS` stay refused even when listed.
   */
  readonly internalTargets?: readonly string[];
  /** More ranges to refuse (cluster pod/Service CIDRs, node networks). */
  readonly extraDenied?: readonly string[];
}

export interface AddressCheckOptions {
  /** The host matched an allowlist pattern marked internal: `internalTargets` are reachable. */
  readonly internal?: boolean;
}

export type AddressVerdict = "allowed" | "forbidden";

function parseCidr(cidr: string): { address: string; prefix: number; type: "ipv4" | "ipv6" } {
  const [address = "", rawPrefix] = cidr.trim().split("/");
  const family = isIP(address);
  const prefix = rawPrefix === undefined ? (family === 6 ? 128 : 32) : Number(rawPrefix);
  const max = family === 6 ? 128 : 32;
  if (family === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new Error(`invalid CIDR ${JSON.stringify(cidr)}`);
  }
  return { address, prefix, type: family === 6 ? "ipv6" : "ipv4" };
}

/**
 * One BlockList per family: node's BlockList matches IPv4 addresses against IPv4-mapped IPv6
 * subnets (::ffff:0:0/96 would cover every IPv4 address), so families are never mixed.
 */
interface FamilyLists {
  readonly ipv4: BlockList;
  readonly ipv6: BlockList;
}

function blockListOf(cidrs: readonly string[]): FamilyLists {
  const lists = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const cidr of cidrs) {
    const { address, prefix, type } = parseCidr(cidr);
    lists[type].addSubnet(address, prefix, type);
  }
  return lists;
}

/** Validates a CIDR list (config). Throws on the first invalid entry. */
export function validateCidrs(cidrs: readonly string[]): void {
  for (const c of cidrs) parseCidr(c);
}

const ALWAYS_DENIED = blockListOf(ALWAYS_DENIED_CIDRS);

function isAlwaysDenied(address: string): boolean {
  const type = isIP(address) === 6 ? "ipv6" : "ipv4";
  return ALWAYS_DENIED[type].check(address, type);
}

/**
 * Validates the internal target list (config, fail fast): every entry a CIDR, none whose network
 * address is always refused (`0.0.0.0/0`, `::/0`, loopback, link-local or metadata entries are
 * configuration mistakes, not targets).
 */
export function validateInternalTargets(cidrs: readonly string[]): void {
  for (const c of cidrs) {
    const { address } = parseCidr(c);
    if (isAlwaysDenied(address)) {
      throw new Error(
        `CIDR ${JSON.stringify(c)} starts in a range that is never reachable (loopback, link-local, metadata, unspecified or IPv4-embedding)`,
      );
    }
  }
}

export class AddressPolicy {
  private readonly denied: FamilyLists;
  private readonly allowed: FamilyLists;
  private readonly internalTargets: FamilyLists;

  constructor(options: AddressPolicyOptions = {}) {
    this.denied = blockListOf([...DEFAULT_DENIED_CIDRS, ...(options.extraDenied ?? [])]);
    this.allowed = blockListOf(options.allowedInternal ?? []);
    this.internalTargets = blockListOf(options.internalTargets ?? []);
  }

  /**
   * An address is allowed when it is an operator's install-wide internal target, or global (not in
   * any denied range), or (only for a host matched by an internal pattern) inside the internal
   * targets and not in `ALWAYS_DENIED_CIDRS`.
   */
  check(address: string, options: AddressCheckOptions = {}): AddressVerdict {
    const family = isIP(address);
    if (family === 0) return "forbidden";
    const type = family === 6 ? "ipv6" : "ipv4";
    if (this.allowed[type].check(address, type)) return "allowed";
    if (!this.denied[type].check(address, type)) return "allowed";
    if (
      options.internal === true &&
      this.internalTargets[type].check(address, type) &&
      !isAlwaysDenied(address)
    ) {
      return "allowed";
    }
    return "forbidden";
  }

  /** All addresses allowed (an empty list is not). One forbidden address refuses the whole name. */
  checkAll(addresses: readonly string[], options: AddressCheckOptions = {}): AddressVerdict {
    if (addresses.length === 0) return "forbidden";
    return addresses.every((a) => this.check(a, options) === "allowed") ? "allowed" : "forbidden";
  }
}
