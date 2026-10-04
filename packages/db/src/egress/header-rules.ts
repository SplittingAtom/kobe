import { z } from "zod";
import { SecretBox } from "../models/secret-box.js";

/**
 * Per-team header injection for an enabled egress domain (spec D28, KOBE-39): e.g. a private
 * package index's `Authorization`. The server seals the headers when a team admin sets them; only
 * the egress proxy opens them, adds them to a sandbox's plain-HTTP request for that domain, and
 * sends the request upstream over verified HTTPS (services/egress-proxy/src/upgrade.ts). Values
 * never leave the server and the proxy: no API returns them and they are never audited or logged.
 */

/** Headers per (team, domain). */
export const MAX_INJECTED_HEADERS = 8;
export const MAX_HEADER_VALUE_LENGTH = 4096;
/** SecretBox purpose: the sealing key is derived for header values only. */
export const EGRESS_HEADER_PURPOSE = "egress-headers";

/** RFC 9110 token: what an HTTP header name may be. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** Visible ASCII and inner spaces/tabs: no CR/LF (header splitting), no leading/trailing space. */
const VALUE = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/;

/**
 * Names the proxy controls itself or that would change how the request is framed or routed:
 * never configurable (lowercase; `proxy-*` and `x-forwarded-*` are refused as prefixes).
 */
const RESERVED = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "via",
  "forwarded",
  "http2-settings",
]);
const RESERVED_PREFIXES = ["proxy-", "x-forwarded-", "x-kobe-"];

export function headerNameProblem(name: string): string | undefined {
  if (!TOKEN.test(name)) return "is not a valid header name";
  const lower = name.toLowerCase();
  if (RESERVED.has(lower) || RESERVED_PREFIXES.some((p) => lower.startsWith(p))) {
    return "is set by the egress proxy and cannot be configured";
  }
  return undefined;
}

export const injectedHeaderSchema = z.strictObject({
  name: z
    .string()
    .max(64)
    .superRefine((name, ctx) => {
      const problem = headerNameProblem(name);
      if (problem) ctx.addIssue({ code: "custom", message: `header name ${problem}` });
    }),
  value: z
    .string()
    .max(MAX_HEADER_VALUE_LENGTH)
    .regex(VALUE, "header value must be visible ASCII without line breaks or outer spaces"),
});

export type InjectedHeader = z.infer<typeof injectedHeaderSchema>;

/** A domain's header list: 1–8 headers, names unique ignoring case. */
export const injectedHeadersSchema = z
  .array(injectedHeaderSchema)
  .min(1)
  .max(MAX_INJECTED_HEADERS)
  .superRefine((headers, ctx) => {
    const seen = new Set<string>();
    for (const h of headers) {
      const lower = h.name.toLowerCase();
      if (seen.has(lower))
        ctx.addIssue({ code: "custom", message: `header ${h.name} is repeated` });
      seen.add(lower);
    }
  });

/** Additional authenticated data: a sealed list opens only for the team and domain it was set for. */
export function headerContext(teamId: string, domain: string): string {
  return `egress-headers:${teamId}:${domain}`;
}

export function headerBox(secrets: string | readonly string[]): SecretBox {
  return new SecretBox(secrets, EGRESS_HEADER_PURPOSE);
}

export function sealHeaders(
  box: SecretBox,
  teamId: string,
  domain: string,
  headers: readonly InjectedHeader[],
): string {
  return box.seal(JSON.stringify(headers), headerContext(teamId, domain));
}

/** Opens and re-validates a sealed list (throws on a wrong key, context or shape). */
export function openHeaders(
  box: SecretBox,
  teamId: string,
  domain: string,
  sealed: string,
): InjectedHeader[] {
  const parsed = injectedHeadersSchema.safeParse(
    JSON.parse(box.open(sealed, headerContext(teamId, domain))),
  );
  if (!parsed.success) throw new Error("sealed egress headers have an invalid shape");
  return parsed.data;
}
