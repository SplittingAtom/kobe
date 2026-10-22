import { z } from "zod";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * `session.renew` (KOBE-483), behind hello capability {@link CAPABILITY_SESSION_RENEW}: the agent
 * hands the live connection the fresh `kobe.sandbox-wire` session token it traded for, before the
 * one the connection was opened with expires. The server verifies it like an upgrade token; when it
 * names the same (sandbox, team, user, eval thread) the connection's expiry moves to the new
 * token's `exp`, so routine token expiry never closes a connection mid-run. A token for another
 * identity closes with `unauthorized`; an invalid or expired one is ignored (the old expiry stands).
 * No answer. Agents without the capability reconnect at expiry as before.
 */
export const CAPABILITY_SESSION_RENEW = "session_renew";

export const sessionRenewFrameSchema = z.strictObject({
  v: z.literal(SANDBOX_WIRE_VERSION),
  type: z.literal("session.renew"),
  /** Same alphabet and length as the upgrade's `Authorization: Bearer` token. */
  token: z
    .string()
    .min(20)
    .max(4096)
    .regex(/^[A-Za-z0-9._~+/=-]+$/),
});
export type SessionRenewFrame = z.infer<typeof sessionRenewFrameSchema>;
