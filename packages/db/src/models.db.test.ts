import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  MODELS_CHANNEL,
  MODELS_CONFIG_CHANGED,
  bumpModelsConfig,
  isActiveRunLeasedTo,
  loadGatewayPrincipal,
} from "./models/index.js";
import {
  modelCatalog,
  modelGatewayKeys,
  modelGatewayState,
  modelProviders,
  runs,
  sandboxRunLeases,
  sandboxes,
  teamMembers,
  teamModels,
  teams,
  threads,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-40: providers and catalog (install-wide), team enablement and gateway keys (team, RLS). */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
const providerId = `p-${teamA.slice(0, 8)}`;
const alias = `a-${teamA.slice(0, 8)}`;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ma-${teamA.slice(0, 8)}`, name: "Models A" },
    { id: teamB, slug: `mb-${teamB.slice(0, 8)}`, name: "Models B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "M", email: `${userId}@m.test` });
  await withTeam(app.db, teamA, (tx) =>
    tx.insert(teamMembers).values({ teamId: teamA, userId, role: "team_admin" }),
  );
  await app.db.insert(modelProviders).values({
    id: providerId,
    kind: "openai_compatible",
    name: "Local vLLM",
    baseUrl: "http://vllm.internal:8000",
    allowPrivateNetwork: true,
    createdBy: userId,
  });
  await app.db
    .insert(modelCatalog)
    .values({ alias, providerId, model: "qwen/qwen3-8b", createdBy: userId });
});
afterAll(() => app.close());

const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("providers and catalog", () => {
  it("vendor kinds are configured once, under their own name, with a key", async () => {
    const bad = [
      { id: "my-openai", kind: "openai" as const, apiKeyEnc: "v1.x" },
      { id: "anthropic", kind: "anthropic" as const, apiKeyEnc: null },
      { id: "ollama", kind: "ollama" as const, apiKeyEnc: null }, // no base URL
      { id: "Bad_Id", kind: "openai_compatible" as const, baseUrl: "http://x" },
      { id: "vllm", kind: "openai_compatible" as const, baseUrl: "ftp://x" },
    ];
    for (const row of bad) {
      const err = await failure(
        app.db.insert(modelProviders).values({ name: "x", createdBy: userId, ...row }),
      );
      expect(pgCode(err), row.id).toBe("23514");
    }
  });

  it("a provider with catalog entries cannot be deleted", async () => {
    const err = await failure(
      app.db.delete(modelProviders).where(eq(modelProviders.id, providerId)),
    );
    expect(pgCode(err)).toBe("23503");
  });

  it("refuses aliases and model ids outside the grammar", async () => {
    for (const [a, m] of [
      ["Smart", "m"],
      ["-x", "m"],
      ["ok-alias", "has space"],
      ["ok-alias", ""],
    ] as const) {
      const err = await failure(
        app.db.insert(modelCatalog).values({ alias: a, providerId, model: m, createdBy: userId }),
      );
      expect(pgCode(err), `${a}/${m}`).toBe("23514");
    }
  });

  it("input modalities default to text, allow image, and refuse anything else (KOBE-191)", async () => {
    const [row] = await app.db.select().from(modelCatalog).where(eq(modelCatalog.alias, alias));
    expect(row?.inputModalities).toEqual(["text"]);
    await app.db
      .update(modelCatalog)
      .set({ inputModalities: ["text", "image"] })
      .where(eq(modelCatalog.alias, alias));
    for (const bad of [[], ["image"], ["text", "video"], ["text", "text", "audio"]]) {
      const err = await failure(
        app.db
          .update(modelCatalog)
          .set({ inputModalities: bad })
          .where(eq(modelCatalog.alias, alias)),
      );
      expect(pgCode(err), bad.join()).toBe("23514");
    }
    await app.db
      .update(modelCatalog)
      .set({ inputModalities: ["text"] })
      .where(eq(modelCatalog.alias, alias));
  });
});

describe("team enablement", () => {
  it("is confined to the team (RLS), references the catalog, and has one default", async () => {
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamModels).values({ teamId: teamA, alias, isDefault: true, enabledBy: userId }),
    );
    const seenByB = await withTeam(app.db, teamB, (tx) => tx.select().from(teamModels));
    expect(seenByB.filter((r) => r.teamId === teamA)).toEqual([]);
    const notInCatalog = await failure(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(teamModels).values({ teamId: teamA, alias: "nope", enabledBy: userId }),
      ),
    );
    expect(pgCode(notInCatalog)).toBe("23503");

    const second = `b-${teamA.slice(0, 8)}`;
    await app.db
      .insert(modelCatalog)
      .values({ alias: second, providerId, model: "m2", createdBy: userId });
    const twoDefaults = await failure(
      withTeam(app.db, teamA, (tx) =>
        tx
          .insert(teamModels)
          .values({ teamId: teamA, alias: second, isDefault: true, enabledBy: userId }),
      ),
    );
    expect(pgCode(twoDefaults)).toBe("23505");
  });

  it("removing an alias from the catalog removes every team's enablement of it", async () => {
    const gone = `c-${teamA.slice(0, 8)}`;
    await app.db
      .insert(modelCatalog)
      .values({ alias: gone, providerId, model: "m3", createdBy: userId });
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamModels).values({ teamId: teamA, alias: gone, enabledBy: userId }),
    );
    await app.db.delete(modelCatalog).where(eq(modelCatalog.alias, gone));
    const rows = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(teamModels).where(eq(teamModels.alias, gone)),
    );
    expect(rows).toEqual([]);
  });
});

describe("gateway sync state", () => {
  it("bumps the desired version and NOTIFYs on commit only", async () => {
    const listener = new pg.Client({ connectionString: inject("appUrl") });
    await listener.connect();
    const hints: string[] = [];
    listener.on("notification", (n) => {
      if (n.channel === MODELS_CHANNEL && n.payload) hints.push(n.payload);
    });
    await listener.query(`LISTEN ${MODELS_CHANNEL}`);
    const [before] = await app.db.select().from(modelGatewayState);
    await failure(
      app.db.transaction(async (tx) => {
        await bumpModelsConfig(tx);
        throw new Error("rolled back");
      }),
    );
    const version = await app.db.transaction((tx) => bumpModelsConfig(tx));
    expect(version).toBe((before?.desiredVersion ?? 0) + 1);
    for (let i = 0; i < 50 && hints.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(hints).toEqual([MODELS_CONFIG_CHANGED]);
    await listener.end();
  });

  it("the app role cannot add or delete the state row", async () => {
    expect(pgCode(await failure(app.db.insert(modelGatewayState).values({ id: 1 })))).toBe("42501");
    expect(pgCode(await failure(app.db.delete(modelGatewayState)))).toBe("42501");
  });
});

describe("gateway principal", () => {
  const sandboxId = randomUUID();

  it("a member with a recorded, running sandbox and a virtual key is live", async () => {
    await withTeam(app.db, teamA, async (tx) => {
      await tx.insert(sandboxes).values({ teamId: teamA, userId, sandboxId, state: "running" });
      await tx
        .insert(modelGatewayKeys)
        .values({ teamId: teamA, userId, vkId: "vk-1", vkValueEnc: "v1.sealed" });
    });
    expect(await loadGatewayPrincipal(app.db, teamA, userId, sandboxId)).toEqual({
      member: true,
      sandbox: "live",
      virtualKey: { id: "vk-1", valueEnc: "v1.sealed" },
      // The team's enabled models as the gateway names them (custom provider kobe-<id>).
      enabledModels: [`kobe-${providerId}/qwen/qwen3-8b`],
    });
  });

  it("another sandbox id, a hibernated or destroyed sandbox is revoked", async () => {
    expect((await loadGatewayPrincipal(app.db, teamA, userId, randomUUID())).sandbox).toBe(
      "revoked",
    );
    for (const state of ["hibernated", "destroyed"] as const) {
      await withTeam(app.db, teamA, (tx) =>
        tx.execute(
          sql`UPDATE sandboxes SET state = ${state}, retain_until = ${state === "destroyed" ? sql`now()` : null}
               WHERE team_id = ${teamA} AND user_id = ${userId}`,
        ),
      );
      expect((await loadGatewayPrincipal(app.db, teamA, userId, sandboxId)).sandbox).toBe(
        "revoked",
      );
    }
  });

  it("another team sees no membership and no key (RLS); no row is unrecorded", async () => {
    expect(await loadGatewayPrincipal(app.db, teamB, userId, sandboxId)).toEqual({
      member: false,
      sandbox: "unrecorded",
      virtualKey: undefined,
      enabledModels: [],
    });
  });

  it("a deactivated user is not a member", async () => {
    const other = randomUUID();
    await app.db
      .insert(users)
      .values({ id: other, name: "D", email: `${other}@m.test`, deactivatedAt: new Date() });
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamMembers).values({ teamId: teamA, userId: other, role: "member" }),
    );
    expect((await loadGatewayPrincipal(app.db, teamA, other, sandboxId)).member).toBe(false);
  });

  it("run attribution: only active runs leased to this sandbox", async () => {
    const runId = await withTeam(app.db, teamA, async (tx) => {
      const [thread] = await tx
        .insert(threads)
        .values({ teamId: teamA, ownerUserId: userId })
        .returning({ id: threads.id });
      if (!thread) throw new Error("no thread");
      const [run] = await tx
        .insert(runs)
        .values({
          teamId: teamA,
          threadId: thread.id,
          trigger: "user",
          status: "running",
          startedAt: new Date(),
        })
        .returning({ id: runs.id });
      if (!run) throw new Error("no run");
      await tx
        .insert(sandboxRunLeases)
        .values({ teamId: teamA, runId: run.id, userId, threadId: thread.id, sandboxId });
      return run.id;
    });
    expect(await isActiveRunLeasedTo(app.db, teamA, runId, sandboxId)).toBe(true);
    expect(await isActiveRunLeasedTo(app.db, teamA, runId, randomUUID())).toBe(false);
    expect(await isActiveRunLeasedTo(app.db, teamB, runId, sandboxId)).toBe(false);
    await withTeam(app.db, teamA, (tx) =>
      tx.execute(
        sql`UPDATE runs SET status = 'completed', ended_at = now() WHERE team_id = ${teamA} AND id = ${runId}`,
      ),
    );
    expect(await isActiveRunLeasedTo(app.db, teamA, runId, sandboxId)).toBe(false);
  });
});
