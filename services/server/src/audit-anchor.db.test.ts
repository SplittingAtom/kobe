import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR, auditStandalone } from "@kobe/db";
import { AuditAnchorLogger, anchorKey, anchorMac } from "./audit/anchor.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-15 review: the chain head is logged (attested with a key outside the database) and each tick
 * verifies the rows since the previous head, so a privileged rewrite shows up in the server log.
 * Own database: these tests tamper with the log for real.
 */
let h: Harness;
const logged: { level: "info" | "error"; obj: Record<string, unknown> }[] = [];
const log = {
  info: (obj: object) => logged.push({ level: "info", obj: obj as Record<string, unknown> }),
  error: (obj: object) => logged.push({ level: "error", obj: obj as Record<string, unknown> }),
};
const SECRET = "anchor-test-secret-".repeat(3);

const event = () =>
  auditStandalone(h.deps.database.db, {
    action: "platform.isolation.changed",
    actor: SYSTEM_ACTOR,
    target: { from: "verified", to: "missing", replica: "anchor-test" },
  });

/** Changes the log the way a privileged role could: triggers bypassed. */
async function tamper(statement: string, values: unknown[] = []): Promise<void> {
  await h.admin.query("BEGIN");
  await h.admin.query("SET LOCAL session_replication_role = replica");
  await h.admin.query(statement, values);
  await h.admin.query("COMMIT");
}

beforeAll(async () => {
  h = await openHarness();
});

afterAll(async () => {
  await h?.close();
});

describe("audit chain anchors", () => {
  it("logs the head with a MAC under a key derived from the secret", async () => {
    const anchor = new AuditAnchorLogger(h.deps.database.db, SECRET, log);
    expect(await anchor.tick()).toEqual({ ok: true, anchor: null }); // empty log: nothing to anchor
    const first = await event();
    const status = await anchor.tick();
    expect(status).toMatchObject({ ok: true, anchor: { seq: first.seq, hash: first.hash } });
    expect(status.anchor?.mac).toBe(anchorMac(anchorKey(SECRET), first.seq, first.hash));
    expect(anchorMac(anchorKey("another secret"), first.seq, first.hash)).not.toBe(
      status.anchor?.mac,
    );
    expect(logged.at(-1)).toMatchObject({ level: "info", obj: { auditHead: { seq: first.seq } } });
  });

  it("verifies only the rows appended since the last head, and moves on", async () => {
    const anchor = new AuditAnchorLogger(h.deps.database.db, SECRET, log);
    await anchor.tick();
    await event();
    const latest = await event();
    expect(await anchor.tick()).toMatchObject({ ok: true, anchor: { seq: latest.seq } });
  });

  it("reports an edited row appended after the last head", async () => {
    const anchor = new AuditAnchorLogger(h.deps.database.db, SECRET, log);
    await anchor.tick();
    const edited = await event();
    await event();
    await tamper(`UPDATE audit_log SET target = '{"forged":true}' WHERE seq = $1`, [edited.seq]);
    expect(await anchor.tick()).toMatchObject({
      ok: false,
      seq: edited.seq,
      problem: "hash_mismatch",
    });
    expect(logged.at(-1)).toMatchObject({ level: "error" });
  });

  it("reports a rewritten or removed anchored head", async () => {
    const anchor = new AuditAnchorLogger(h.deps.database.db, SECRET, log);
    const head = await event();
    await anchor.tick();
    await tamper(`DELETE FROM audit_log WHERE seq = $1`, [head.seq]);
    expect(await anchor.tick()).toMatchObject({ ok: false, seq: head.seq });
  });
});
