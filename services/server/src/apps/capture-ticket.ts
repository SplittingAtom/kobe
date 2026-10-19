import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * MCP Apps capture tickets (KOBE-438, spec MA10, T11). When the server allows a model's call to a
 * tool that opens a pinned, approved `ui://` template, it hands the proxy a ticket: an HMAC over
 * who called (team, user, sandbox), where (thread, run), what (connector, tool, Pi name, input
 * digest) and which template. The proxy returns it with the upstream's result; only a valid,
 * unexpired ticket that matches the reporting sandbox is stored. A sandbox has neither the
 * internal key nor this key, so it can neither report nor forge a result.
 */
export const CAPTURE_TICKET_TTL_MS = 5 * 60_000;
const MAX_TICKET_LENGTH = 4096;
const PURPOSE = "kobe.mcp-apps.capture-ticket.v1";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const claimsSchema = z.strictObject({
  teamId: z.uuid(),
  userId: z.uuid(),
  sandboxId: z.string().min(1).max(256),
  threadId: z.uuid(),
  runId: z.uuid(),
  connectorId: z.uuid(),
  tool: z.string().min(1).max(128),
  piName: z.string().min(1).max(256),
  inputSha256: hex64,
  templateUri: z.string().min(1).max(2048),
  templateSha256: hex64,
  appId: hex64,
});
export type CaptureClaims = z.infer<typeof claimsSchema>;

const envelopeSchema = z.strictObject({ claims: claimsSchema, exp: z.number().int() });

/** The ticket key, derived from the server's own secret for this purpose only. */
export function captureKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(PURPOSE).digest();
}

const mac = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest();

export function signCaptureTicket(key: Buffer, claims: CaptureClaims, now: Date): string {
  const body = Buffer.from(
    JSON.stringify({ claims, exp: now.getTime() + CAPTURE_TICKET_TTL_MS }),
  ).toString("base64url");
  return `${body}.${mac(key, body).toString("base64url")}`;
}

export function verifyCaptureTicket(
  key: Buffer,
  ticket: string,
  now: Date,
): CaptureClaims | undefined {
  if (ticket.length > MAX_TICKET_LENGTH) return undefined;
  const parts = ticket.split(".");
  if (parts.length !== 2) return undefined;
  const [body, sig] = parts as [string, string];
  const expected = mac(key, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString()));
    if (!parsed.success || parsed.data.exp < now.getTime()) return undefined;
    return parsed.data.claims;
  } catch {
    return undefined;
  }
}
