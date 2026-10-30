import { createHmac, hkdfSync } from "node:crypto";

/**
 * A token in the retired HMAC format (`krt1` run tokens, `ksc1` server-call tokens; KOBE-118/234):
 * `<prefix>.<b64url claims>.<HMAC-SHA256>` keyed by HKDF over a master secret the gateway used to
 * share with the server. The gateway must refuse these whatever the key (KOBE-521).
 */
export function hmacEraToken(kind: "run" | "server-call", claims: unknown, master: string): string {
  const [prefix, info] =
    kind === "run" ? ["krt1", "kobe/run-token/v1"] : ["ksc1", "kobe/server-call-token/v1"];
  const key = new Uint8Array(hkdfSync("sha256", master, new Uint8Array(0), info, 32));
  const signed = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${signed}.${createHmac("sha256", key).update(signed, "ascii").digest("base64url")}`;
}
