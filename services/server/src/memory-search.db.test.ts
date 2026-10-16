import { randomBytes, randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMemory, type ReadRequest } from "./memory/agent.js";
import { memoryBlobKey } from "./memory/keys.js";
import { EventStreamFixture } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import type { GetOptions } from "./workspace-sync/object-store.js";

/**
 * KOBE-240: `recall` search over 200+ docs. The candidate docs (and their current blob keys) are
 * listed in one short `withTeam` transaction; the bodies are read from the object store after it
 * committed, so no connection sits idle in a transaction while up to 200 objects are fetched.
 * Ranking and limits are unchanged (path order, 200 docs, 20 files, 256 KiB).
 */
const PREFIX = "kobe/";
const DOCS = 210;

/** Calls `probe` before every get, so a test can look at the database while a blob is read. */
class ProbedObjects extends MemoryObjects {
  probe: ((key: string) => Promise<void>) | undefined;
  override async get(key: string, options?: GetOptions) {
    await this.probe?.(key);
    return super.get(key, options);
  }
}

const fx = new EventStreamFixture();
const objects = new ProbedObjects();
const log = pino({ level: "silent" });

beforeAll(async () => {
  await fx.setup([{}], () => ({ blobs: { objects, prefix: PREFIX } }));
});

afterAll(async () => {
  await fx.teardown();
});

const path = (i: number) => `n${String(i).padStart(3, "0")}.md`;
/** Every 7th doc mentions the needle; doc 205 (past the 200-doc window) alone says "lonely". */
const content = (i: number) =>
  i === 205 ? "lonely" : i % 7 === 0 ? `note ${i}: the NEEDLE is here` : `note ${i}`;

interface World {
  readonly req: Omit<ReadRequest, "input">;
}

async function world(): Promise<World> {
  const owner = await fx.person(`s${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`srch-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const threadId = rows[0]?.thread_id ?? "";
  // Newest-updated first in the listing, so path order must come from the search itself.
  for (let i = 0; i < DOCS; i++) {
    const id = randomUUID();
    const key = memoryBlobKey(PREFIX, team, id, 1);
    const bytes = Buffer.from(content(i), "utf8");
    objects.objects.set(key, bytes);
    await fx.admin.query(
      `WITH d AS (
         INSERT INTO memory_docs (team_id, id, scope, owner_user_id, path, current_version, updated_at)
         VALUES ($1, $2, 'user', $3, $4, 1, now() - make_interval(secs => $5)) RETURNING id)
       INSERT INTO memory_doc_versions (team_id, doc_id, version, blob_ref, size_bytes, sha256, actor_kind, actor_user_id)
       SELECT $1, d.id, 1, $6, $7, $8, 'user', $3 FROM d`,
      [team, id, owner.id, path(i), DOCS - i, key, bytes.length, "0".repeat(64)],
    );
  }
  return {
    req: { teamId: team, userId: owner.id, runId, threadId, refused: () => undefined },
  };
}

/** Backends sitting in a transaction whose last statement touched memory tables. */
async function memoryTxOpen(): Promise<number> {
  const { rows } = await fx.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'
        AND query ILIKE '%memory_doc%'`,
  );
  return Number(rows[0]?.n ?? 0);
}

const deps = () => ({ db: fx.db, blobs: { objects, prefix: PREFIX }, log });

describe("recall search over 200+ docs (KOBE-240)", () => {
  it("reads no blob while a memory transaction is open, with unchanged ranking and limits", async () => {
    const w = await world();
    const open: number[] = [];
    objects.probe = async () => {
      open.push(await memoryTxOpen());
    };
    try {
      const found = await readMemory(deps(), { ...w.req, input: { query: "needle" } });
      // The first 200 docs by path are searched; 29 match, the answer stops at 20 files.
      const want = Array.from({ length: 20 }, (_, k) => k * 7).map((i) => ({
        scope: "user",
        path: path(i),
        content: content(i),
        version: 1,
      }));
      expect(found).toEqual({ ok: true, op: "read", files: want, truncated: true });
      expect(open.length).toBeGreaterThan(0);
      expect(open.every((n) => n === 0)).toBe(true);
    } finally {
      objects.probe = undefined;
    }
  });

  it("a doc past the 200-doc window is not searched; a path read still finds it", async () => {
    const w = await world();
    const open: number[] = [];
    objects.probe = async () => {
      open.push(await memoryTxOpen());
    };
    try {
      expect(await readMemory(deps(), { ...w.req, input: { query: "lonely" } })).toEqual({
        ok: true,
        op: "read",
        files: [],
        truncated: true,
      });
      expect(await readMemory(deps(), { ...w.req, input: { path: path(205) } })).toEqual({
        ok: true,
        op: "read",
        files: [{ scope: "user", path: path(205), content: "lonely", version: 1 }],
        truncated: false,
      });
      expect(open.every((n) => n === 0)).toBe(true);
    } finally {
      objects.probe = undefined;
    }
  });

  it("a missing object is skipped and an ended run reads nothing", async () => {
    const w = await world();
    const { rows } = await fx.admin.query<{ blob_ref: string }>(
      `SELECT v.blob_ref FROM memory_doc_versions v JOIN memory_docs d
          ON d.team_id = v.team_id AND d.id = v.doc_id WHERE d.team_id = $1 AND d.path = $2`,
      [w.req.teamId, path(0)],
    );
    objects.lost.add(rows[0]?.blob_ref ?? "");
    const found = await readMemory(deps(), { ...w.req, input: { query: "needle" } });
    expect(found.ok && found.op === "read" ? found.files.map((f) => f.path)[0] : null).toBe(
      path(7),
    );
    await fx.complete(w.req.teamId, w.req.runId);
    const ended = await readMemory(deps(), { ...w.req, input: { query: "needle" } });
    expect(ended.ok).toBe(false);
  });
});
