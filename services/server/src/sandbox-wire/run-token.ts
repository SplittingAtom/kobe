import { randomUUID } from "node:crypto";
import { recordRunToken, type KobeTx } from "@kobe/db";
import type { RunTokenGrant } from "@kobe/protocol";
import { deriveTraceSpanKey } from "@kobe/protocol/node";
import {
  loadSigningKey,
  signRunToken,
  signingKeyEnvName,
  type SessionSigningKey,
} from "@kobe/session-token";

/**
 * The run token key (KOBE-118, Ed25519 since KOBE-521): the `kobe.model-gateway` session-token
 * private key (`KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY`), which only the server holds; the gateway
 * verifies with the public half. Run tokens carry their own signed `typ` (`krt2`), so they never
 * pass as session tokens. Undefined (no run tokens) when the key is unset or unreadable; the
 * sandbox config load then fails with the reason.
 */
export function runTokenKeyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SessionSigningKey | undefined {
  const name = signingKeyEnvName("kobe.model-gateway");
  const pem = env[name];
  if (!pem?.trim()) return undefined;
  try {
    return loadSigningKey(pem, name);
  } catch {
    return undefined;
  }
}

/** The trace-span secret (KOBE-521): shared with the model gateway, authorises nothing. */
export const TRACE_SPAN_KEY_ENV = "KOBE_TRACE_SPAN_KEY";

/**
 * `k_trace` (KOBE-274): remaps relayed sandbox span ids. Derived from `KOBE_TRACE_SPAN_KEY`, a
 * pseudonymisation secret the model gateway holds too (it remaps the same ids); no credential is
 * derived from it. Undefined (no span relay) when unset or shorter than 32 bytes; a set but
 * too-short secret is reported through `warn` (once, at startup), never echoing the value.
 */
export function traceSpanKeyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  warn?: (message: string) => void,
): Uint8Array | undefined {
  const secret = env[TRACE_SPAN_KEY_ENV];
  if (!secret) return undefined;
  try {
    return deriveTraceSpanKey(new TextEncoder().encode(secret));
  } catch {
    warn?.(`${TRACE_SPAN_KEY_ENV} is shorter than 32 bytes: sandbox span relay is off`);
    return undefined;
  }
}

export interface MintRunTokenInput {
  readonly key: SessionSigningKey;
  readonly teamId: string;
  readonly runId: string;
  readonly sandboxId: string;
  readonly ttlSeconds: number;
  readonly now?: Date;
}

/**
 * Mints a token for one run on one sandbox and records its `jti` in the caller's transaction (the
 * one that leases the run), so a token never exists without its record. The token text is only
 * returned, never stored.
 */
export async function mintRunToken(tx: KobeTx, input: MintRunTokenInput): Promise<RunTokenGrant> {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const exp = iat + input.ttlSeconds;
  const jti = randomUUID();
  const grant = signRunToken(input.key, {
    iss: "kobe-server",
    aud: "kobe.model-gateway",
    run_id: input.runId,
    team_id: input.teamId,
    sandbox_id: input.sandboxId,
    iat,
    exp,
    jti,
  });
  await recordRunToken(tx, {
    teamId: input.teamId,
    jti,
    runId: input.runId,
    sandboxId: input.sandboxId,
    expiresAt: new Date(exp * 1000),
  });
  return grant;
}
