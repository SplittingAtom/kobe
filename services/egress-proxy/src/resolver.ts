import { Resolver } from "node:dns/promises";

/** Resolves a host name to IP addresses (IPv4 first). Throws when it has none. */
export type ResolveHost = (host: string) => Promise<string[]>;

export class DnsError extends Error {
  override readonly name = "DnsError";
}

/**
 * DNS through c-ares, not getaddrinfo: no /etc/hosts, no libuv threadpool, bounded time. The name is
 * queried as an absolute name (trailing dot), so the pod's search domains (`*.svc.cluster.local`)
 * never turn an allowlisted public name into a cluster-internal one.
 */
export function dnsResolver(options: { timeoutMs: number; tries?: number }): ResolveHost {
  const resolver = new Resolver({ timeout: options.timeoutMs, tries: options.tries ?? 2 });
  return async (host) => {
    const fqdn = `${host}.`;
    const settle = (p: Promise<string[]>) => p.catch(() => [] as string[]);
    const [v4, v6] = await Promise.all([
      settle(resolver.resolve4(fqdn)),
      settle(resolver.resolve6(fqdn)),
    ]);
    const all = [...v4, ...v6];
    if (all.length === 0) throw new DnsError(`no addresses for ${host}`);
    return all;
  };
}
