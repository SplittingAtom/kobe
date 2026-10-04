import {
  MODELS_BUDGETS_PREFIX,
  MODELS_CHANNEL,
  MODELS_KEYS_PREFIX,
  MODELS_SPEND_PREFIX,
  and,
  eq,
  isNull,
  modelCatalog,
  modelGatewayKeys,
  modelGatewayState,
  modelProviders,
  notifyModels,
  providerKeyContext,
  scanTeams,
  sql,
  teamMembers,
  teamModels,
  users,
  virtualKeyContext,
  withTeam,
  type KobeDb,
  type SecretBox,
} from "@kobe/db";
import pg from "pg";
import type { Logger } from "pino";
import type { BifrostAdmin } from "./bifrost-admin.js";
import {
  buildDesiredState,
  virtualKeyName,
  type GovernanceLimitsSource,
  type ProviderInput,
  type TeamInput,
} from "./desired.js";
import { reconcile } from "./reconcile.js";

/** Session advisory lock held by the one replica that syncs the gateway ("kobe" + 40). */
export const MODELS_SYNC_LOCK_KEY = 0x6b6f_6265_0040;

export interface ModelGatewaySyncOptions {
  readonly db: KobeDb;
  /** Direct (or session-mode) connection for LISTEN and the leader lock. */
  readonly connectionString: string;
  readonly admin: BifrostAdmin;
  readonly providerKeys: SecretBox;
  readonly virtualKeys: SecretBox;
  /** HMAC secret for key fingerprints in Bifrost key names (server-only secret). */
  readonly fingerprintSecret: string;
  readonly logger: Logger;
  /** Full pass period (besides hints). */
  readonly intervalMs: number;
  /** Budgets/rate limits per level (KOBE-42). */
  readonly limits?: GovernanceLimitsSource;
  readonly leaderRetryMs?: number;
  readonly debounceMs?: number;
}

export interface PassResult {
  readonly ok: boolean;
  readonly version: number;
  readonly changes: number;
  readonly keysWritten: number;
  readonly errors: readonly string[];
}

interface CurrentKey {
  readonly vkId: string;
  readonly valueEnc: string;
}

interface TeamSnapshot extends TeamInput {
  readonly keys: ReadonlyMap<string, CurrentKey>;
}

/**
 * Keeps Bifrost in step with Kobe (KOBE-40, spec D30; "No Redis"). Every replica LISTENs on
 * `kobe_models`; the one holding {@link MODELS_SYNC_LOCK_KEY} (a session lock on its LISTEN
 * connection, released if that replica dies) runs the passes: on every change hint (debounced),
 * every `intervalMs`, and on becoming leader. A pass that fails retries with backoff. Each pass
 * records its progress in `model_gateway_state` (`synced_version` = the version it applied).
 */
export class ModelGatewaySync {
  private client: pg.Client | undefined;
  private leader = false;
  private closed = false;
  private running: Promise<void> | undefined;
  private dirty = false;
  private failures = 0;
  private timers = new Set<NodeJS.Timeout>();
  private periodic: NodeJS.Timeout | undefined;
  private attempt = 0;

  constructor(private readonly options: ModelGatewaySyncOptions) {}

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    void this.connect();
    this.periodic = setInterval(() => this.request(), this.options.intervalMs);
    this.periodic.unref();
  }

  /** Asks for a pass (coalesced; only the leader runs it). */
  request(): void {
    if (!this.leader || this.closed) return;
    this.dirty = true;
    this.later(this.options.debounceMs ?? 250, () => void this.drain());
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  private async drain(): Promise<void> {
    if (this.running || !this.leader || this.closed) return;
    this.running = (async () => {
      while (this.dirty && this.leader && !this.closed) {
        this.dirty = false;
        const result = await this.runOnce().catch((err: unknown) => {
          this.options.logger.error({ err }, "model gateway sync pass failed");
          return undefined;
        });
        if (!result?.ok) {
          // Retry with backoff (2 s doubling to 30 s); hints in between still coalesce.
          const delay = Math.min(30_000, 2_000 * 2 ** this.failures++);
          this.later(delay, () => this.request());
          break;
        }
        this.failures = 0;
      }
    })();
    await this.running;
    this.running = undefined;
    if (this.dirty) void this.drain();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const { logger } = this.options;
    const client = new pg.Client({
      connectionString: this.options.connectionString,
      connectionTimeoutMillis: 10_000,
    });
    client.on("error", (err) => {
      logger.warn({ err }, "model gateway sync listener error");
      this.lost(client);
    });
    client.on("end", () => this.lost(client));
    client.on("notification", (n) => {
      if (n.channel !== MODELS_CHANNEL) return;
      // `keys:<team>` is the sync's own output for the shims; spend and budget hints are for the
      // budget monitor and the shims' caches (a rate-limit change bumps the desired version).
      const payload = n.payload ?? "";
      if (
        payload.startsWith(MODELS_KEYS_PREFIX) ||
        payload.startsWith(MODELS_SPEND_PREFIX) ||
        payload.startsWith(MODELS_BUDGETS_PREFIX)
      ) {
        return;
      }
      this.request();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${MODELS_CHANNEL}`);
      if (this.closed) {
        await client.end();
        return;
      }
      this.client = client;
      this.attempt = 0;
      await this.tryLead(client);
    } catch (err) {
      logger.warn({ err }, "model gateway sync listener could not connect");
      this.lost(client);
    }
  }

  private async tryLead(client: pg.Client): Promise<void> {
    if (this.closed || this.client !== client) return;
    try {
      const res = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [
        MODELS_SYNC_LOCK_KEY,
      ]);
      if (res.rows[0]?.ok) {
        this.leader = true;
        this.options.logger.info("model gateway sync: leading");
        this.request();
        return;
      }
    } catch (err) {
      this.options.logger.warn({ err }, "model gateway sync could not take the leader lock");
    }
    // Another replica leads: check again later (it releases the lock when its connection ends).
    this.later(this.options.leaderRetryMs ?? 10_000, () => void this.tryLead(client));
  }

  private lost(client: pg.Client): void {
    if (this.client !== undefined && this.client !== client) return;
    if (this.client === undefined && this.closed) return;
    const wasCurrent = this.client === client;
    this.client = undefined;
    this.leader = false;
    client.end().catch(() => undefined);
    if (this.closed || !wasCurrent) return;
    const delay = Math.min(10_000, 250 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.later(delay, () => void this.connect());
  }

  async close(): Promise<void> {
    this.closed = true;
    this.leader = false;
    if (this.periodic) clearInterval(this.periodic);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.running;
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }

  /** One full pass (also called directly by tests). */
  async runOnce(): Promise<PassResult> {
    const { db, logger } = this.options;
    const [state] = await db.select().from(modelGatewayState);
    const version = state?.desiredVersion ?? 0;
    const { providers, catalog, teams, unreadable } = await this.loadInputs();
    const desired = buildDesiredState(
      { providers, catalog, teams },
      this.options.fingerprintSecret,
      this.options.limits,
    );
    const result = await reconcile(desired, this.options.admin, logger);
    const keysWritten = await this.writeKeys(teams, result.virtualKeys);
    const errors = [...result.errors, ...(unreadable ? ["provider_key_unreadable"] : [])];
    const ok = errors.length === 0;
    await db
      .update(modelGatewayState)
      .set(
        ok
          ? {
              syncedVersion: sql`GREATEST(${modelGatewayState.syncedVersion}, ${version})`,
              lastSyncedAt: new Date(),
              lastAttemptAt: new Date(),
              lastError: null,
            }
          : { lastAttemptAt: new Date(), lastError: errors[0] ?? "sync_failed" },
      )
      .where(eq(modelGatewayState.id, 1));
    if (result.changes > 0 || keysWritten > 0 || !ok) {
      logger.info(
        { version, changes: result.changes, keysWritten, errors },
        ok ? "model gateway synced" : "model gateway sync incomplete",
      );
    }
    return { ok, version, changes: result.changes, keysWritten, errors };
  }

  private async loadInputs(): Promise<{
    providers: ProviderInput[];
    catalog: { alias: string; providerId: string; model: string }[];
    teams: TeamSnapshot[];
    unreadable: boolean;
  }> {
    const { db, logger, providerKeys } = this.options;
    const [providerRows, catalog] = await Promise.all([
      db.select().from(modelProviders),
      db
        .select({
          alias: modelCatalog.alias,
          providerId: modelCatalog.providerId,
          model: modelCatalog.model,
        })
        .from(modelCatalog),
    ]);
    let unreadable = false;
    const reseal: { id: string; revision: number; apiKey: string }[] = [];
    const providers = providerRows.map((p): ProviderInput => {
      let apiKey: string | undefined;
      if (p.apiKeyEnc !== null) {
        try {
          apiKey = providerKeys.open(p.apiKeyEnc, providerKeyContext(p.id, p.keyRevision));
          if (!providerKeys.isCurrent(p.apiKeyEnc))
            reseal.push({ id: p.id, revision: p.keyRevision, apiKey });
        } catch {
          // A rotated or wrong secret: the provider is pushed without its key (calls fail).
          unreadable = true;
          logger.error({ provider: p.id }, "provider API key could not be opened");
        }
      }
      return {
        id: p.id,
        kind: p.kind,
        baseUrl: p.baseUrl,
        allowPrivateNetwork: p.allowPrivateNetwork,
        apiKey,
      };
    });
    // Keys sealed with a previous secret (rotation): re-seal with the current one.
    for (const r of reseal) {
      await db
        .update(modelProviders)
        .set({ apiKeyEnc: providerKeys.seal(r.apiKey, providerKeyContext(r.id, r.revision)) })
        .where(and(eq(modelProviders.id, r.id), eq(modelProviders.keyRevision, r.revision)));
      logger.info({ provider: r.id }, "provider API key re-sealed with the current secret");
    }
    const teams = await scanTeams(db, "model gateway sync", async (tx, team) => {
      const members = await tx
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(and(eq(teamMembers.teamId, team.id), isNull(users.deactivatedAt)));
      const aliases = await tx
        .select({ alias: teamModels.alias })
        .from(teamModels)
        .where(eq(teamModels.teamId, team.id));
      // KOBE-42: the members' request rate (the install's, or the team's lower one).
      const rate = await tx.execute<{ rpm: number }>(sql`
        SELECT LEAST(l.user_requests_per_minute,
                     COALESCE(b.user_requests_per_minute, l.user_requests_per_minute)) AS rpm
          FROM install_model_limits l
          LEFT JOIN team_budgets b ON b.team_id = ${team.id}::uuid AND b.user_id IS NULL
         WHERE l.id = 1`);
      const keys = await tx
        .select({
          userId: modelGatewayKeys.userId,
          vkId: modelGatewayKeys.vkId,
          valueEnc: modelGatewayKeys.vkValueEnc,
        })
        .from(modelGatewayKeys)
        .where(eq(modelGatewayKeys.teamId, team.id));
      return {
        teamId: team.id,
        members: members.map((m) => m.userId).sort(),
        aliases: aliases.map((a) => a.alias),
        ...(rate.rows[0] ? { requestsPerMinute: Number(rate.rows[0].rpm) } : {}),
        keys: new Map(keys.map((k) => [k.userId, { vkId: k.vkId, valueEnc: k.valueEnc }])),
      };
    });
    return { providers, catalog, teams, unreadable };
  }

  /**
   * Stores each member's virtual key (sealed) where it changed and removes keys of former members;
   * a team whose keys changed gets a `keys:<team>` hint so the shims drop their cached copies.
   */
  private async writeKeys(
    teams: readonly TeamSnapshot[],
    observed: ReadonlyMap<string, { readonly id: string; readonly value: string }>,
  ): Promise<number> {
    const { db, virtualKeys } = this.options;
    let written = 0;
    for (const team of teams) {
      const upserts: { userId: string; vkId: string; value: string }[] = [];
      for (const userId of team.members) {
        const vk = observed.get(virtualKeyName(team.teamId, userId));
        if (!vk) continue;
        const current = team.keys.get(userId);
        if (
          current &&
          current.vkId === vk.id &&
          this.opens(current, team.teamId, userId, vk.value)
        ) {
          continue;
        }
        upserts.push({ userId, vkId: vk.id, value: vk.value });
      }
      const members = new Set(team.members);
      const stale = [...team.keys.keys()].filter((u) => !members.has(u));
      if (upserts.length === 0 && stale.length === 0) continue;
      await withTeam(db, team.teamId, async (tx) => {
        for (const u of upserts) {
          const sealed = virtualKeys.seal(u.value, virtualKeyContext(team.teamId, u.userId));
          await tx
            .insert(modelGatewayKeys)
            .values({ teamId: team.teamId, userId: u.userId, vkId: u.vkId, vkValueEnc: sealed })
            .onConflictDoUpdate({
              target: [modelGatewayKeys.teamId, modelGatewayKeys.userId],
              set: { vkId: u.vkId, vkValueEnc: sealed, updatedAt: new Date() },
            });
        }
        for (const userId of stale) {
          await tx
            .delete(modelGatewayKeys)
            .where(
              and(eq(modelGatewayKeys.teamId, team.teamId), eq(modelGatewayKeys.userId, userId)),
            );
        }
        await notifyModels(tx, `${MODELS_KEYS_PREFIX}${team.teamId}`);
      });
      written += upserts.length + stale.length;
    }
    return written;
  }

  /** The stored value opens to `value` with the current secret (else it is re-sealed). */
  private opens(current: CurrentKey, teamId: string, userId: string, value: string): boolean {
    const box = this.options.virtualKeys;
    try {
      return (
        box.isCurrent(current.valueEnc) &&
        box.open(current.valueEnc, virtualKeyContext(teamId, userId)) === value
      );
    } catch {
      return false;
    }
  }
}
