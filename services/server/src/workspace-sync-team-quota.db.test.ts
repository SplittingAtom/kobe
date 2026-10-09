import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKSPACE_SYNC_PATH, type WorkspaceChange } from "@kobe/protocol";
import { createSandboxApp } from "./routes/sandbox.js";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandboxAuth } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { KEYS } from "./testing/sandbox-fixtures.js";
import { runWithAuditContext } from "./audit/context.js";
import { storeUpload } from "./uploads/store.js";
import type { UploadSettings } from "./uploads/settings.js";
import { createSandboxAuthenticator, createWorkspaceSync } from "./workspace-sync/index.js";

/**
 * KOBE-185: workspace sync pushes count against the team storage quota (files + live workspace
 * bytes) under the same per-team advisory lock as uploads.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const objects = new MemoryObjects();
const settings: UploadSettings = {
  maxFileBytes: 10_000,
  maxMessageBytes: 10_000,
  defaultQuotaBytes: 1000,
  orphanHours: 24,
};

let app: ReturnType<typeof createSandboxApp>;

beforeAll(async () => {
  await fx.setup([{}]);
  const live = createWorkspaceSync({
    db: fx.db,
    objects,
    prefix: "",
    limits: { maxFileBytes: 1 << 20, maxWorkspaceBytes: 8 << 20, maxFiles: 1000 },
    teamStorageDefaultBytes: settings.defaultQuotaBytes,
    log: silent,
  });
  const authenticate = createSandboxAuthenticator({
    db: fx.db,
    verify: auth.verify,
    liveness: auth.liveness,
  });
  app = createSandboxApp({
    provider: { identifyBootstrapToken: () => Promise.reject(new Error("unused")) },
    sessionKeys: KEYS,
    workspace: live.routes(authenticate),
  });
});
afterAll(() => fx.teardown());

interface Box {
  teamId: string;
  person: Person;
  token: string;
}

async function box(person?: Person, teamId?: string, members: Person[] = []): Promise<Box> {
  const p = person ?? (await fx.person(`q${randomBytes(2).toString("hex")}`));
  const t = teamId ?? (await fx.team(`tq-${randomBytes(3).toString("hex")}`, p, members));
  const token = auth.issue({ sandboxId: randomUUID(), teamId: t, userId: p.id });
  return { teamId: t, person: p, token };
}

function call(b: Box, method: string, path: string, body?: unknown, raw?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${b.token}` };
  let payload: string | undefined;
  if (raw !== undefined) {
    payload = raw;
    headers["content-length"] = String(Buffer.byteLength(raw));
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return app.request(`${WORKSPACE_SYNC_PATH}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
}

const change = (path: string, data: string): WorkspaceChange => ({
  op: "put",
  path,
  base_rev: null,
  sha256: sha(data),
  size: Buffer.byteLength(data),
  mtime_ms: 1,
  executable: false,
});

/** Uploads the blob, then pushes it; returns the per-change result code. */
async function push(b: Box, path: string, data: string): Promise<string> {
  expect((await call(b, "PUT", `/blobs/${sha(data)}`, undefined, data)).status).toBe(201);
  const res = await call(b, "POST", "/commit", { changes: [change(path, data)] });
  const body = (await res.json()) as { results: { status: string; code?: string }[] };
  const r = body.results[0];
  return r?.status === "applied" ? "applied" : (r?.code ?? "?");
}

const fileUpload = (b: Box, size: number) =>
  runWithAuditContext({ actor: { kind: "user", id: b.person.id }, ip: null, userAgent: null }, () =>
    storeUpload(
      { db: fx.db, blobs: { objects, prefix: "" }, settings },
      { teamId: b.teamId, userId: b.person.id },
      {
        threadId: undefined,
        name: "a.bin",
        declaredMime: "",
        file: Readable.from([Buffer.alloc(size, 97)]),
        contentLength: undefined,
      },
    ),
  );

const setQuota = (b: Box, bytes: number) =>
  fx.admin.query(
    `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, $2, $3)`,
    [b.teamId, bytes, b.person.id],
  );

describe("workspace sync and the team storage quota", () => {
  it("refuses a push that takes the team over its quota, counting uploads and other workspaces", async () => {
    const other = await fx.person(`o${randomBytes(2).toString("hex")}`);
    const a = await box(undefined, undefined, [other]);
    const b = await box(other, a.teamId);
    await setQuota(a, 1000);
    expect((await fileUpload(a, 600)).ok).toBe(true);
    expect(await push(a, "big.txt", "x".repeat(500))).toBe("quota_exceeded");
    expect(await push(a, "ok.txt", "y".repeat(300))).toBe("applied");
    expect(await push(b, "more.txt", "z".repeat(200))).toBe("quota_exceeded");
    expect(await push(b, "fits.txt", "z".repeat(100))).toBe("applied");
  });

  it("lets a shrinking push through when the team is already over", async () => {
    const a = await box();
    expect(await push(a, "f.txt", "a".repeat(800))).toBe("applied");
    await setQuota(a, 100);
    const res = await call(a, "POST", "/commit", {
      changes: [{ op: "delete", path: "f.txt", base_rev: 1 }],
    });
    expect(res.status).toBe(200);
  });

  it("an upload and a sync push racing at the quota edge: exactly one wins", async () => {
    for (let i = 0; i < 5; i++) {
      const a = await box();
      await setQuota(a, 1000);
      const data = "r".repeat(700);
      expect((await call(a, "PUT", `/blobs/${sha(data)}`, undefined, data)).status).toBe(201);
      const [up, pushed] = await Promise.all([
        fileUpload(a, 700),
        Promise.resolve(call(a, "POST", "/commit", { changes: [change("race.txt", data)] })).then(
          async (r) =>
            ((await r.json()) as { results: { status: string }[] }).results[0]?.status ?? "?",
        ),
      ]);
      const wins = (up.ok ? 1 : 0) + (pushed === "applied" ? 1 : 0);
      expect(wins).toBe(1);
    }
  });
});
