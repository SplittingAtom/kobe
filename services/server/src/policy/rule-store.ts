import { z } from "zod";
import {
  and,
  asc,
  count,
  eq,
  installSettings,
  installToolRules,
  sql,
  toolRules,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { argPatternSchema, globSchema, type ArgPattern } from "@kobe/protocol";
import type { PolicyRuleSource, PolicySettingsSource } from "./engine.js";
import { allowGlobScoped } from "./patterns.js";
import type { PolicyRule, RuleEffect, RuleScope } from "./rules.js";
import {
  DEFAULT_POLICY_SETTINGS,
  PROMPT_SANDBOX_WRITES_KEY,
  type PolicySettings,
} from "./settings.js";

/** A stored rule as the admin API shows it (snake_case, like the protocol's `ToolRule`). */
export interface StoredRule {
  readonly id: string;
  readonly scope: "install" | "team" | "user";
  readonly scope_ref: string | null;
  readonly effect: RuleEffect;
  readonly tool_glob: string;
  readonly arg_pattern: ArgPattern | null;
  readonly note: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly expires_at: string | null;
}

export interface RuleFields {
  readonly tool_glob: string;
  readonly arg_pattern: ArgPattern | null;
  readonly note: string | null;
  readonly expires_at: string | null;
}

type InstallRow = typeof installToolRules.$inferSelect;
type TeamRow = typeof toolRules.$inferSelect;

/**
 * Turns a stored row into an engine rule. Rows are validated on write, but a row that fails the
 * grammar on read (manual SQL, a future grammar change) fails closed: a bad allow rule is
 * dropped (as is an allow rule that isn't scoped to one tool or connector); a bad deny/ask rule keeps restricting — an unreadable arg pattern is ignored (the rule
 * covers every call of its tool) and an unreadable tool glob covers every tool.
 */
export function toPolicyRule(
  row: Pick<InstallRow, "id" | "effect" | "toolGlob" | "argPattern" | "expiresAt">,
  scope: RuleScope,
): PolicyRule | undefined {
  const glob = globSchema.safeParse(row.toolGlob);
  const args = row.argPattern === null ? undefined : argPatternSchema.safeParse(row.argPattern);
  const valid = glob.success && (args === undefined || args.success);
  if (row.effect === "allow" && (!valid || !allowGlobScoped(row.toolGlob))) return undefined;
  return {
    id: row.id,
    scope,
    effect: row.effect,
    tool_glob: glob.success ? glob.data : "*",
    ...(args?.success ? { arg_pattern: args.data } : {}),
    ...(row.expiresAt ? { expires_at: row.expiresAt.toISOString() } : {}),
  };
}

function compact<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((v): v is T => v !== undefined);
}

const notExpired = (
  column: typeof installToolRules.expiresAt | typeof toolRules.expiresAt,
  now: Date,
) => sql`(${column} IS NULL OR ${column} > ${now.toISOString()}::timestamptz)`;

/**
 * Reads the rules for one decision: the install floor (install-wide) and, under the team's RLS,
 * the team's rules plus the acting user's own. Two indexed queries.
 *
 * Call it (i.e. `PolicyEngine.decide`) outside any `withTeam` transaction: nested withTeam is
 * refused, which the engine turns into a fail-closed deny.
 */
export function createDbRuleSource(db: KobeDb): PolicyRuleSource {
  return {
    async load(teamId, userId, now) {
      const [install, scoped] = await Promise.all([
        db.select().from(installToolRules).where(notExpired(installToolRules.expiresAt, now)),
        withTeam(db, teamId, (tx) =>
          tx
            .select()
            .from(toolRules)
            .where(
              and(
                sql`(${toolRules.scope} = 'team' OR (${toolRules.scope} = 'user' AND ${toolRules.userId} = ${userId}::uuid))`,
                notExpired(toolRules.expiresAt, now),
              ),
            ),
        ),
      ]);
      return {
        install: compact(install.map((r) => toPolicyRule(r, "install"))),
        team: compact(scoped.filter((r) => r.scope === "team").map((r) => toPolicyRule(r, "team"))),
        user: compact(scoped.filter((r) => r.scope === "user").map((r) => toPolicyRule(r, "user"))),
      };
    },
  };
}

const booleanSetting = z.enum(["true", "false"]).transform((v) => v === "true");

/** The install's policy switches; an unreadable stored value takes the stricter setting. */
export async function readPromptSandboxWrites(db: KobeDb): Promise<PolicySettings> {
  const [row] = await db
    .select({ value: installSettings.value })
    .from(installSettings)
    .where(eq(installSettings.key, PROMPT_SANDBOX_WRITES_KEY));
  if (!row) return DEFAULT_POLICY_SETTINGS;
  const parsed = booleanSetting.safeParse(row.value);
  return { promptSandboxWrites: parsed.success ? parsed.data : true };
}

/** Policy switches from `install_settings`, cached for `ttlMs` (default 5 s) across decisions. */
export function createDbSettingsSource(db: KobeDb, ttlMs = 5_000): PolicySettingsSource {
  let cached: { at: number; value: Promise<PolicySettings> } | undefined;
  return {
    get() {
      const now = Date.now();
      if (!cached || now - cached.at >= ttlMs) {
        const value = readPromptSandboxWrites(db);
        cached = { at: now, value };
        // A failed read is not cached: the next decision retries.
        value.catch(() => {
          if (cached?.value === value) cached = undefined;
        });
      }
      return cached.value;
    },
  };
}

export async function writePromptSandboxWrites(db: KobeDb, value: boolean): Promise<void> {
  const text = String(value);
  await db
    .insert(installSettings)
    .values({ key: PROMPT_SANDBOX_WRITES_KEY, value: text })
    .onConflictDoUpdate({
      target: installSettings.key,
      set: { value: text, updatedAt: new Date() },
    });
}

// --- Admin CRUD -------------------------------------------------------------------------------

function storedInstall(row: InstallRow): StoredRule {
  return {
    id: row.id,
    scope: "install",
    scope_ref: null,
    effect: row.effect,
    tool_glob: row.toolGlob,
    arg_pattern: row.argPattern ?? null,
    note: row.note,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt?.toISOString() ?? null,
  };
}

function storedTeam(row: TeamRow): StoredRule {
  return {
    id: row.id,
    scope: row.scope,
    scope_ref: row.scope === "team" ? row.teamId : row.userId,
    effect: row.effect,
    tool_glob: row.toolGlob,
    arg_pattern: row.argPattern ?? null,
    note: row.note,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt?.toISOString() ?? null,
  };
}

function columns(fields: RuleFields) {
  return {
    toolGlob: fields.tool_glob,
    argPattern: fields.arg_pattern,
    note: fields.note,
    expiresAt: fields.expires_at === null ? null : new Date(fields.expires_at),
  };
}

export type CreateResult = { ok: true; rule: StoredRule } | { ok: false; error: "too_many_rules" };

export async function listInstallRules(db: KobeDb): Promise<StoredRule[]> {
  const rows = await db
    .select()
    .from(installToolRules)
    .orderBy(asc(installToolRules.createdAt), asc(installToolRules.id));
  return rows.map(storedInstall);
}

export async function createInstallRule(
  db: KobeDb,
  body: RuleFields & { effect: "deny" | "ask" },
  createdBy: string,
  limit: number,
): Promise<CreateResult> {
  return db.transaction(async (tx) => {
    // Serialize creators so the cap holds under concurrency.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kobe.install_tool_rules'))`);
    const [total] = await tx.select({ n: count() }).from(installToolRules);
    if ((total?.n ?? 0) >= limit) return { ok: false, error: "too_many_rules" } as const;
    const [row] = await tx
      .insert(installToolRules)
      .values({ effect: body.effect, createdBy, ...columns(body) })
      .returning();
    if (!row) throw new Error("install rule insert returned no row");
    return { ok: true, rule: storedInstall(row) } as const;
  });
}

export async function updateInstallRule(
  db: KobeDb,
  id: string,
  body: RuleFields & { effect: "deny" | "ask" },
): Promise<StoredRule | undefined> {
  const [row] = await db
    .update(installToolRules)
    .set({ effect: body.effect, ...columns(body) })
    .where(eq(installToolRules.id, id))
    .returning();
  return row ? storedInstall(row) : undefined;
}

export async function deleteInstallRule(db: KobeDb, id: string): Promise<boolean> {
  const rows = await db
    .delete(installToolRules)
    .where(eq(installToolRules.id, id))
    .returning({ id: installToolRules.id });
  return rows.length > 0;
}

export async function listTeamRules(db: KobeDb, teamId: string): Promise<StoredRule[]> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select()
      .from(toolRules)
      .where(eq(toolRules.scope, "team"))
      .orderBy(asc(toolRules.createdAt), asc(toolRules.id)),
  );
  return rows.map(storedTeam);
}

async function countScoped(tx: KobeTx, scope: "team" | "user", userId?: string): Promise<number> {
  const where =
    scope === "team"
      ? eq(toolRules.scope, "team")
      : and(eq(toolRules.scope, "user"), eq(toolRules.userId, userId ?? ""));
  const [total] = await tx.select({ n: count() }).from(toolRules).where(where);
  return total?.n ?? 0;
}

/** Serializes rule creation per (team, scope[, user]) so caps hold under concurrency. */
async function lockScope(tx: KobeTx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

export async function createTeamRule(
  db: KobeDb,
  teamId: string,
  body: RuleFields & { effect: RuleEffect },
  createdBy: string,
  limit: number,
): Promise<CreateResult> {
  return withTeam(db, teamId, async (tx) => {
    await lockScope(tx, `kobe.tool_rules.team.${teamId}`);
    if ((await countScoped(tx, "team")) >= limit)
      return { ok: false, error: "too_many_rules" } as const;
    const [row] = await tx
      .insert(toolRules)
      .values({ teamId, scope: "team", effect: body.effect, createdBy, ...columns(body) })
      .returning();
    if (!row) throw new Error("team rule insert returned no row");
    return { ok: true, rule: storedTeam(row) } as const;
  });
}

export async function updateTeamRule(
  db: KobeDb,
  teamId: string,
  id: string,
  body: RuleFields & { effect: RuleEffect },
): Promise<StoredRule | undefined> {
  const [row] = await withTeam(db, teamId, (tx) =>
    tx
      .update(toolRules)
      .set({ effect: body.effect, ...columns(body) })
      .where(and(eq(toolRules.id, id), eq(toolRules.scope, "team")))
      .returning(),
  );
  return row ? storedTeam(row) : undefined;
}

export async function deleteTeamRule(db: KobeDb, teamId: string, id: string): Promise<boolean> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .delete(toolRules)
      .where(and(eq(toolRules.id, id), eq(toolRules.scope, "team")))
      .returning({ id: toolRules.id }),
  );
  return rows.length > 0;
}

export async function listUserRules(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<StoredRule[]> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select()
      .from(toolRules)
      .where(and(eq(toolRules.scope, "user"), eq(toolRules.userId, userId)))
      .orderBy(asc(toolRules.createdAt), asc(toolRules.id)),
  );
  return rows.map(storedTeam);
}

/** Revokes one of the caller's own remember-rules (D29: revocable in settings). */
export async function deleteUserRule(
  db: KobeDb,
  teamId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .delete(toolRules)
      .where(and(eq(toolRules.id, id), eq(toolRules.scope, "user"), eq(toolRules.userId, userId)))
      .returning({ id: toolRules.id }),
  );
  return rows.length > 0;
}

export { countScoped, lockScope, storedTeam };
