import { and, eq, isNull, sql } from "drizzle-orm";
import type { KobeDb, KobeTx } from "../client.js";
import {
  modelGatewayKeys,
  sandboxRunLeases,
  sandboxes,
  teamMembers,
  users,
  type ModelProviderKind,
} from "../schema/index.js";
import { withTeam } from "../with-team.js";

/**
 * Change hints for the model gateway (KOBE-40; CLAUDE.md "No Redis"). Payloads carry ids only (any
 * session may LISTEN):
 *
 * - {@link MODELS_CONFIG_CHANGED}: providers, catalog or a team's enablement changed (committed with
 *   the change, together with a `desired_version` bump); the server's gateway sync reconciles.
 * - `ensure:<team>:<user>`: the shim found no virtual key for a member; the sync creates it now.
 * - {@link MODELS_RESYNC}: the shim saw Bifrost refuse a virtual key Kobe holds (Bifrost lost its
 *   state); the sync re-pushes everything.
 * - `keys:<team>`: the sync changed virtual keys of that team; shims drop their cached copies.
 */
export const MODELS_CHANNEL = "kobe_models";
export const MODELS_CONFIG_CHANGED = "config";
export const MODELS_RESYNC = "resync";
export const MODELS_ENSURE_PREFIX = "ensure:";
export const MODELS_KEYS_PREFIX = "keys:";

/** HKDF purposes of the two sealing secrets (secret-box.ts). */
export const PROVIDER_KEY_PURPOSE = "model-provider-key";
export const VIRTUAL_KEY_PURPOSE = "model-gateway-virtual-key";
export const providerKeyContext = (providerId: string) => `provider:${providerId}`;
export const virtualKeyContext = (teamId: string, userId: string) => `vk:${teamId}:${userId}`;

/**
 * Bifrost's name for a provider: vendor kinds use Bifrost's own provider (the kind), every
 * OpenAI-compatible endpoint is a custom provider `kobe-<id>` (never colliding with a Bifrost
 * vendor name). Sandboxes name a model to the gateway as `<bifrost provider>/<model>`.
 */
export function gatewayProviderName(id: string, kind: ModelProviderKind): string {
  return kind === "openai_compatible" ? `kobe-${id}` : kind;
}

export async function notifyModels(db: KobeDb | KobeTx, hint: string): Promise<void> {
  await db.execute(sql`SELECT pg_notify(${MODELS_CHANNEL}, ${hint})`);
}

/**
 * Marks the gateway configuration changed in `tx` (an admin change): bumps `desired_version` and
 * queues the hint, both delivered on commit. Returns the new version.
 */
export async function bumpModelsConfig(tx: KobeTx): Promise<number> {
  const res = await tx.execute<{ v: string }>(sql`
    UPDATE model_gateway_state SET desired_version = desired_version + 1
     WHERE id = 1 RETURNING desired_version AS v`);
  await notifyModels(tx, MODELS_CONFIG_CHANGED);
  return Number(res.rows[0]?.v ?? 0);
}

export type SandboxLiveness = "live" | "unrecorded" | "revoked";

export interface GatewayPrincipal {
  /** Active (not deactivated) member of the team. */
  readonly member: boolean;
  /**
   * The `sandboxes` row (KOBE-25) for (team, user): `revoked` when it is destroyed, hibernated or
   * names another sandbox; `unrecorded` when there is no row or no sandbox id yet (tokens are only
   * minted for live claims, KOBE-22); `live` when it names this sandbox and it is running.
   */
  readonly sandbox: SandboxLiveness;
  readonly virtualKey: { readonly id: string; readonly valueEnc: string } | undefined;
}

/** Everything the model-gateway shim checks for a verified token, in one team transaction. */
export async function loadGatewayPrincipal(
  db: KobeDb,
  teamId: string,
  userId: string,
  sandboxId: string,
): Promise<GatewayPrincipal> {
  return withTeam(db, teamId, async (tx) => {
    const member = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
          isNull(users.deactivatedAt),
        ),
      )
      .limit(1);
    const [box] = await tx
      .select({ sandboxId: sandboxes.sandboxId, state: sandboxes.state })
      .from(sandboxes)
      .where(and(eq(sandboxes.teamId, teamId), eq(sandboxes.userId, userId)));
    const [vk] = await tx
      .select({ id: modelGatewayKeys.vkId, valueEnc: modelGatewayKeys.vkValueEnc })
      .from(modelGatewayKeys)
      .where(and(eq(modelGatewayKeys.teamId, teamId), eq(modelGatewayKeys.userId, userId)));
    let sandbox: SandboxLiveness = "unrecorded";
    if (box?.sandboxId) {
      sandbox =
        box.sandboxId === sandboxId && box.state === "running" ? "live" : ("revoked" as const);
    } else if (box && box.state !== "running") {
      sandbox = "revoked";
    }
    return { member: member.length > 0, sandbox, virtualKey: vk };
  });
}

/** Whether `runId` is leased to this sandbox (KOBE-24): the shim's run attribution check. */
export async function isRunLeasedTo(
  db: KobeDb,
  teamId: string,
  runId: string,
  sandboxId: string,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({ runId: sandboxRunLeases.runId })
      .from(sandboxRunLeases)
      .where(
        and(
          eq(sandboxRunLeases.teamId, teamId),
          eq(sandboxRunLeases.runId, runId),
          eq(sandboxRunLeases.sandboxId, sandboxId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}
