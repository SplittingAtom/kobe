import { BlockList, isIP } from "node:net";

/**
 * Where the egress proxy may connect (spec D28; SSRF and DNS-rebinding protection). The proxy
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
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

export interface AddressPolicyOptions {
  /** Internal targets an operator explicitly allows (still subject to the domain allowlist). */
  readonly allowedInternal?: readonly string[];
  /** More ranges to refuse (cluster pod/Service CIDRs, node networks). */
  readonly extraDenied?: readonly string[];
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

export class AddressPolicy {
  private readonly denied: FamilyLists;
  private readonly allowed: FamilyLists;

  constructor(options: AddressPolicyOptions = {}) {
    this.denied = blockListOf([...DEFAULT_DENIED_CIDRS, ...(options.extraDenied ?? [])]);
    this.allowed = blockListOf(options.allowedInternal ?? []);
  }

  check(address: string): AddressVerdict {
    const family = isIP(address);
    if (family === 0) return "forbidden";
    const type = family === 6 ? "ipv6" : "ipv4";
    if (this.allowed[type].check(address, type)) return "allowed";
    return this.denied[type].check(address, type) ? "forbidden" : "allowed";
  }

  /** All addresses allowed (an empty list is not). One forbidden address refuses the whole name. */
  checkAll(addresses: readonly string[]): AddressVerdict {
    if (addresses.length === 0) return "forbidden";
    return addresses.every((a) => this.check(a) === "allowed") ? "allowed" : "forbidden";
  }
}
