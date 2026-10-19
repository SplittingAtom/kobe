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
  threads,
  users,
  type ModelProviderKind,
  type ThinkingControlValue,
  type ThinkingLevelValue,
  type ThinkingLowestValue,
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
  /**
   * Those of them the site catalog marks as reasoning (`model_catalog.reasoning`, KOBE-259): a
   * server call to one may use the purpose's reasoning headroom (KOBE-219). Absent: none.
   */
  readonly reasoningModels?: readonly string[];
  /**
   * The thinking settings of the team's enabled models that have a thinking control (KOBE-260):
   * the site's and the team's maximum, per alias (several aliases may name one model; the
   * gateway keeps the strictest). The gateway writes the call's level in the control's form.
   * Absent: none (an older store).
   */
  readonly thinking?: readonly GatewayThinkingRow[];
  /**
   * The token is an Orbit eval Job's (KOBE-93): its calls belong to no run, so they use the
   * model's default thinking level; any other sandbox call without a run gets the lowest.
   */
  readonly eval?: true;
}

/** One enabled alias's thinking settings as the gateway reads them (KOBE-260). */
export interface GatewayThinkingRow {
  /** `<gateway provider>/<model>`. */
  readonly model: string;
  readonly control: ThinkingControlValue;
  readonly allowed: boolean;
  readonly default: ThinkingLevelValue | null;
  readonly max: ThinkingLevelValue | null;
  /** The lowest level the model accepts (`low`: it cannot turn thinking off). */
  readonly lowest: ThinkingLowestValue;
  /** The team's maximum (null: the site's). */
  readonly teamMax: ThinkingLevelValue | null;
}

/** Everything the model-gateway shim checks for a verified token, in one team transaction. */
export async function loadGatewayPrincipal(
  db: KobeDb,
  teamId: string,
  userId: string,
  /** Undefined for a server call (KOBE-234): no sandbox and no eval; `sandbox` is `unrecorded`. */
  sandboxId: string | undefined,
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
        reasoning: modelCatalog.reasoning,
        control: modelCatalog.thinkingControl,
        allowed: modelCatalog.thinkingAllowed,
        default: modelCatalog.thinkingDefault,
        max: modelCatalog.thinkingMax,
        lowest: modelCatalog.thinkingLowest,
        teamMax: teamModels.thinkingMax,
      })
      .from(teamModels)
      .innerJoin(modelCatalog, eq(modelCatalog.alias, teamModels.alias))
      .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
      .where(eq(teamModels.teamId, teamId));
    const named = (e: (typeof enabled)[number]) =>
      `${gatewayProviderName(e.providerId, e.kind)}/${e.model}`;
    const enabledModels = [...new Set(enabled.map(named))].sort();
    const thinking: GatewayThinkingRow[] = enabled
      .filter((e) => e.control !== "none")
      .map((e) => ({
        model: named(e),
        control: e.control,
        allowed: e.allowed,
        default: e.default,
        max: e.max,
        lowest: e.lowest,
        teamMax: e.teamMax,
      }));
    // An Orbit eval Job (KOBE-93) presents its eval id as the sandbox: live while the eval runs.
    if (sandboxId === undefined) {
      // Several aliases may name one model: it reasons if any of them says so.
      const reasoningModels = [...new Set(enabled.filter((e) => e.reasoning).map(named))].sort();
      return {
        member: member.length > 0,
        sandbox: "unrecorded",
        virtualKey: vk,
        enabledModels,
        reasoningModels,
        thinking,
      };
    }
    const [evalRun] = await tx
      .select({ status: orbitEvals.status, model: orbitEvals.model })
      .from(orbitEvals)
      .where(
        and(
          eq(orbitEvals.teamId, teamId),
          eq(orbitEvals.id, sandboxId),
          eq(orbitEvals.requestedBy, userId),
        ),
      );
    // A skill eval's ephemeral sandbox (KOBE-325): live while it is connected as an eval thread's
    // sandbox of this member and that execution runs; never judged by the member's own row.
    // The same predicate as the wire's liveness (`evalExecutionLive`, review L7): an open
    // connection, a running execution and an open eval run of this starter.
    const skillEval = await tx.execute(sql`
      SELECT 1 FROM sandbox_eval_connections c
        JOIN skill_eval_results x ON x.team_id = c.team_id AND x.thread_id = c.thread_id
        JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
       WHERE c.team_id = ${teamId} AND c.sandbox_id = ${sandboxId} AND c.user_id = ${userId}
         AND c.closed_at IS NULL
         AND x.state IN ('starting', 'running', 'collecting')
         AND r.started_by = ${userId} AND r.status IN ('queued', 'running')
         AND r.cancel_requested_at IS NULL
       LIMIT 1`);
    let sandbox: SandboxLiveness = "unrecorded";
    if (evalRun) {
      sandbox = evalRun.status === "running" ? "live" : "revoked";
    } else if (skillEval.rows.length > 0) {
      sandbox = "live";
    } else if (box?.sandboxId) {
      sandbox =
        box.sandboxId === sandboxId && box.state === "running" ? "live" : ("revoked" as const);
    } else if (box && box.state !== "running") {
      sandbox = "revoked";
    }
    // An eval token may call only the model its eval was started with.
    const allowed = evalRun ? enabledModels.filter((m) => m === evalRun.model) : enabledModels;
    return {
      member: member.length > 0,
      sandbox,
      virtualKey: vk,
      enabledModels: allowed,
      thinking: thinking.filter((t) => allowed.includes(t.model)),
      ...(evalRun ? { eval: true as const } : {}),
    };
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

/**
 * A run's effective thinking level (KOBE-260), fixed when it started: what the gateway writes into
 * each of the run's calls (clamped again to the model's current settings). Undefined: no such
 * run, or a run without a level.
 */
export async function runThinkingLevelOf(
  db: KobeDb,
  teamId: string,
  runId: string,
): Promise<ThinkingLevelValue | undefined> {
  return withTeam(db, teamId, async (tx) => {
    const [row] = await tx
      .select({ level: runs.thinkingLevel })
      .from(runs)
      .where(and(eq(runs.teamId, teamId), eq(runs.id, runId)))
      .limit(1);
    return row?.level ?? undefined;
  });
}

/** A run's Langfuse session (KOBE-274): its thread and that thread's owner. */
export interface RunSession {
  readonly threadId: string;
  readonly userId: string;
}

/**
 * The session of a run the gateway already attributed (KOBE-274 ac-6): `session.id` = thread,
 * `user.id` = `threads.owner_user_id`, read from the server's record, never from the caller.
 */
export async function runSessionOf(
  db: KobeDb,
  teamId: string,
  runId: string,
): Promise<RunSession | undefined> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({ threadId: runs.threadId, userId: threads.ownerUserId })
      .from(runs)
      .innerJoin(threads, and(eq(threads.teamId, runs.teamId), eq(threads.id, runs.threadId)))
      .where(and(eq(runs.teamId, teamId), eq(runs.id, runId), eq(threads.teamId, teamId)))
      .limit(1);
    return rows[0];
  });
}

/** What a server-call token claims about the run that triggered it (KOBE-234). */
export interface ServerCallRunClaim {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
}

/**
 * Whether a server call's claims match the record (KOBE-234 review L1): the run is a completed run
 * of that thread, leased to that member (`sandbox_run_leases`, kept after the run ends), so a
 * server bug cannot charge another member's budget for a thread's title or follow-ups. One read
 * by primary keys, in the team's RLS context.
 */
export async function serverCallRunMatches(
  db: KobeDb,
  claim: ServerCallRunClaim,
): Promise<boolean> {
  return withTeam(db, claim.teamId, async (tx) => {
    const rows = await tx
      .select({ runId: runs.id })
      .from(runs)
      .innerJoin(
        sandboxRunLeases,
        and(eq(sandboxRunLeases.teamId, runs.teamId), eq(sandboxRunLeases.runId, runs.id)),
      )
      .where(
        and(
          eq(runs.teamId, claim.teamId),
          eq(runs.id, claim.runId),
          eq(runs.threadId, claim.threadId),
          eq(runs.status, "completed"),
          eq(sandboxRunLeases.userId, claim.userId),
          eq(sandboxRunLeases.threadId, claim.threadId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}
