import { randomBytes } from "node:crypto";
import type { Envelope } from "@kobe/db";
import { z } from "zod";
import { OauthError } from "./http.js";

/**
 * The `state` of a connect flow is the flow's server-side memory, sealed with the install
 * envelope instead of stored: `<team>.<connector>.<envelope>`. The envelope binds the payload to
 * (team, user, connector), so a state opens only for the user it was minted for, in the team and
 * for the connector it names; tampering fails the AEAD. The payload holds the PKCE verifier, so it
 * is encrypted, not just signed.
 */
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface FlowSubject {
  readonly teamId: string;
  readonly userId: string;
  readonly connectorId: string;
}

const payloadSchema = z.object({
  v: z.literal(1),
  exp: z.number(),
  nonce: z.string(),
  verifier: z.string().min(43).max(128),
  resource: z.string(),
  issuer: z.string(),
  issRequired: z.boolean(),
  tokenEndpoint: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
});
export type FlowPayload = z.infer<typeof payloadSchema>;

const context = (s: FlowSubject) =>
  ({ teamId: s.teamId, kind: "oauth_state", recordId: `${s.userId}:${s.connectorId}` }) as const;

export function sealState(
  envelope: Envelope,
  subject: FlowSubject,
  payload: Omit<FlowPayload, "v" | "exp" | "nonce">,
  now: Date,
): string {
  const full: FlowPayload = {
    ...payload,
    v: 1,
    exp: now.getTime() + STATE_TTL_MS,
    nonce: randomBytes(8).toString("base64url"),
  };
  return `${subject.teamId}.${subject.connectorId}.${envelope.seal(JSON.stringify(full), context(subject))}`;
}

/** Splits the unsealed prefix; the team and connector are checked against the session after. */
export function stateTarget(state: string): { teamId: string; connectorId: string } | undefined {
  const [teamId, connectorId, ...rest] = state.split(".");
  const uuid = z.uuid();
  if (!uuid.safeParse(teamId).success || !uuid.safeParse(connectorId).success) return undefined;
  if (rest.length === 0 || state.length > 4096) return undefined;
  return { teamId: teamId ?? "", connectorId: connectorId ?? "" };
}

/** Opens a state for `userId`; every failure is the same `invalid_state`. */
export function openState(
  envelope: Envelope,
  state: string,
  userId: string,
  now: Date,
): { subject: FlowSubject; payload: FlowPayload } {
  const target = stateTarget(state);
  if (!target) throw new OauthError("invalid_state");
  const subject: FlowSubject = { ...target, userId };
  try {
    const sealed = state.split(".").slice(2).join(".");
    const parsed = payloadSchema.parse(JSON.parse(envelope.openString(sealed, context(subject))));
    if (parsed.exp < now.getTime()) throw new OauthError("invalid_state");
    return { subject, payload: parsed };
  } catch {
    throw new OauthError("invalid_state");
  }
}
