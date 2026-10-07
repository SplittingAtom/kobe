import { randomUUID } from "node:crypto";
import { recordRunToken, type KobeTx } from "@kobe/db";
import type { RunTokenGrant } from "@kobe/protocol";
import { deriveRunTokenKey, signRunToken } from "@kobe/protocol/node";

/** Minimum length of the master secret (the gateway's session key) the run token key derives from. */
const MASTER_ENV = "KOBE_SESSION_KEY_MODEL_GATEWAY";

/**
 * The run token key (KOBE-118): HKDF of the model-gateway session key, which the gateway already
 * holds, so no new secret is deployed. Undefined (no run tokens) when the key is unset or too
 * short; the gateway then keeps the legacy advisory behaviour.
 */
export function runTokenKeyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Uint8Array | undefined {
  const master = env[MASTER_ENV];
  if (!master) return undefined;
  try {
    return deriveRunTokenKey(new TextEncoder().encode(master));
  } catch {
    return undefined;
  }
}

export interface MintRunTokenInput {
  readonly key: Uint8Array;
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
