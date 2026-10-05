import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { KobeDb, KobeTx } from "../client.js";
import {
  ACTIVE_RUN_STATUSES,
  modelCatalog,
  modelGatewayKeys,
  modelProviders,
  runs,
  sandboxRunLeases,
  orbitEvals,
  sandboxes,
  teamMembers,
  teamModels,
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
 * - `spend:<team>` / `budgets:<team|*>` (KOBE-42): usage written / budgets changed.
 */
export const MODELS_CHANNEL = "kobe_models";
export const MODELS_CONFIG_CHANGED = "config";
export const MODELS_RESYNC = "resync";
export const MODELS_ENSURE_PREFIX = "ensure:";
export const MODELS_KEYS_PREFIX = "keys:";
/** KOBE-42: `spend:<team>` — new usage rows for the team (budget monitor, shims' budget caches). */
export const MODELS_SPEND_PREFIX = "spend:";
/** KOBE-42: `budgets:<team>` or `budgets:*` — budgets or rate limits changed. */
export const MODELS_BUDGETS_PREFIX = "budgets:";

/** HKDF purposes of the two sealing secrets (secret-box.ts). */
export const PROVIDER_KEY_PURPOSE = "model-provider-key";
export const VIRTUAL_KEY_PURPOSE = "model-gateway-virtual-key";
/** A provider key's AAD names its revision: a sealed value never opens as another revision's. */
export const providerKeyContext = (providerId: string, revision: number) =>
  `provider:${providerId}:r${revision}`;
/** HKDF purpose of the key-fingerprint secret (derived from the provider-key secret). */
export const KEY_FINGERPRINT_PURPOSE = "model-key-fingerprint";
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
   * names another sandbox; `live` when it names this sandbox and it is running; `unrecorded` when
   * there is no row or no sandbox id yet. Unrecorded is accepted: tokens are only minted for live
   * claims (KOBE-22) and KOBE-25 writes the row on wake, so a running sandbox may not have one
   * yet. Offboarding (KOBE-28) must therefore mark the row `destroyed` (not delete it) or remove
   * the membership, or the sandbox's last tokens stay usable until they expire (≤ 15 min).
   */
  readonly sandbox: SandboxLiveness;
  readonly virtualKey: { readonly id: string; readonly valueEnc: string } | undefined;
  /**
   * The team's enabled models as the gateway names them (`<gateway provider>/<model>`): the shim
   * refuses anything else itself, so a disable holds even if a push to Bifrost failed.
   */
  readonly enabledModels: readonly string[];
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
    const enabled = await tx
      .select({
        providerId: modelProviders.id,
        kind: modelProviders.kind,
        model: modelCatalog.model,
      })
      .from(teamModels)
      .innerJoin(modelCatalog, eq(modelCatalog.alias, teamModels.alias))
      .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
      .where(eq(teamModels.teamId, teamId));
    const enabledModels = [
      ...new Set(enabled.map((e) => `${gatewayProviderName(e.providerId, e.kind)}/${e.model}`)),
    ].sort();
    // An Orbit eval Job (KOBE-93) presents its eval id as the sandbox: live while the eval runs.
    const [evalRun] = await tx
      .select({ status: orbitEvals.status })
      .from(orbitEvals)
      .where(
        and(
          eq(orbitEvals.teamId, teamId),
          eq(orbitEvals.id, sandboxId),
          eq(orbitEvals.requestedBy, userId),
        ),
      );
    let sandbox: SandboxLiveness = "unrecorded";
    if (evalRun) {
      sandbox = evalRun.status === "running" ? "live" : "revoked";
    } else if (box?.sandboxId) {
      sandbox =
        box.sandboxId === sandboxId && box.state === "running" ? "live" : ("revoked" as const);
    } else if (box && box.state !== "running") {
      sandbox = "revoked";
    }
    return { member: member.length > 0, sandbox, virtualKey: vk, enabledModels };
  });
}

/**
 * Whether `runId` is an **active** run (running or waiting for approval) leased to this sandbox
 * (KOBE-24 leases): the shim's run attribution check. Ended runs no longer attribute.
 */
export async function isActiveRunLeasedTo(
  db: KobeDb,
  teamId: string,
  runId: string,
  sandboxId: string,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({ runId: sandboxRunLeases.runId })
      .from(sandboxRunLeases)
      .innerJoin(
        runs,
        and(eq(runs.teamId, sandboxRunLeases.teamId), eq(runs.id, sandboxRunLeases.runId)),
      )
      .where(
        and(
          eq(sandboxRunLeases.teamId, teamId),
          eq(sandboxRunLeases.runId, runId),
          eq(sandboxRunLeases.sandboxId, sandboxId),
          inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}
