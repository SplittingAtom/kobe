import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uploadErrorSchema, uploadResponseSchema } from "@kobe/protocol";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import { RawBody } from "./testing/browser.js";
import { EICAR, startFakeClamd, type FakeClamd } from "./testing/fake-clamd.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import type { UploadSettings } from "./uploads/settings.js";

/**
 * KOBE-146: POST /v1/uploads with ClamAV on (a fake clamd): clean -> stored with scan_status
 * `clean`; EICAR -> 422 `scan_rejected`, object deleted, no row, audited; clamd down -> 503
 * `scan_unavailable` (fail closed), nothing stored.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
let clamd: FakeClamd;

beforeAll(async () => {
  clamd = await startFakeClamd();
  const settings: UploadSettings = {
    maxFileBytes: 100_000,
    maxMessageBytes: 500_000,
    defaultQuotaBytes: 10_000_000,
    orphanHours: 24,
    clamav: { host: "127.0.0.1", port: clamd.port, timeoutMs: 2000 },
  };
  await fx.setup([{}], () => ({ blobs: { objects, prefix: PREFIX }, uploads: settings }));
});
afterAll(async () => {
  await clamd.close();
  await fx.teardown();
});

async function body(content: string): Promise<RawBody> {
  const form = new FormData();
  form.append("file", new File([content], "f.txt", { type: "text/plain" }));
  const req = new Request("http://x.test/", { method: "POST", body: form });
  return new RawBody(
    new Uint8Array(await req.arrayBuffer()),
    req.headers.get("content-type") ?? "",
  );
}
const upload = async (p: Person, content: string) =>
  p.browser.post("/v1/uploads", await body(content));
const rowsOf = async (team: string) =>
  (await fx.admin.query(`SELECT scan_status FROM files WHERE team_id = $1`, [team])).rows;
const auditOf = async (team: string) =>
  (
    await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'workspace.upload_scan_refused' ORDER BY seq`,
      [team],
    )
  ).rows.map((r) => r.target);

describe("upload scanning", () => {
  it("stores a clean file with scan clean", async () => {
    const owner = await fx.person("scan-clean");
    const team = await fx.team("t-scan-clean", owner);
    const res = await upload(owner, "hello");
    expect(res.status, res.text).toBe(201);
    expect(uploadResponseSchema.parse(res.json).scan).toBe("clean");
    expect(await rowsOf(team)).toEqual([{ scan_status: "clean" }]);
    expect(clamd.scans()).toBeGreaterThan(0);
  });

  it("rejects EICAR: 422, object deleted, no row, audited without content", async () => {
    const owner = await fx.person("scan-bad");
    const team = await fx.team("t-scan-bad", owner);
    const res = await upload(owner, `prefix ${EICAR} suffix`);
    expect(res.status).toBe(422);
    expect(uploadErrorSchema.parse(res.json).code).toBe("scan_rejected");
    expect(await rowsOf(team)).toHaveLength(0);
    expect(objects.keys(`${PREFIX}teams/${team}/`)).toEqual([]);
    expect(await auditOf(team)).toEqual([
      { userId: owner.id, reason: "scan_rejected", bytes: `prefix ${EICAR} suffix`.length },
    ]);
    expect(JSON.stringify(await auditOf(team))).not.toContain("EICAR-STANDARD");
  });

  it("fails closed with 503 when clamd is down", async () => {
    const owner = await fx.person("scan-down");
    const team = await fx.team("t-scan-down", owner);
    await clamd.close();
    const res = await upload(owner, "hello");
    expect(res.status).toBe(503);
    expect(uploadErrorSchema.parse(res.json).code).toBe("scan_unavailable");
    expect(await rowsOf(team)).toHaveLength(0);
    expect(objects.keys(`${PREFIX}teams/${team}/`)).toEqual([]);
    expect(await auditOf(team)).toEqual([
      { userId: owner.id, reason: "scan_unavailable", bytes: 5 },
    ]);
  });
});
