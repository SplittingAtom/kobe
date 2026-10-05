import { randomBytes, randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_ARTIFACTS, type PolicyEngine } from "@kobe/protocol";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { exportZip } from "./retention/export.js";
import { blobRecorder } from "./retention/job.js";
import { deleteReleasedBlobs, purgeThreads } from "./retention/index.js";

/**
 * KOBE-129 end to end: `artifact.put` accepted only per D-3 of KOBE-55 (capability, active leased
 * run, an allowed tool call with the same input hash, same team and thread for updates, idempotent
 * on the tool call), content in object storage under a server-derived key, events on the run's
 * stream, the /v1/artifacts API, retention purge and export.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs = { objects, prefix: PREFIX };
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

/** Allows everything except a call titled "deny" (the real engine is covered by policy tests). */
const engine: PolicyEngine = {
  decide: (input) => {
    const denied = (input.input as { title?: string }).title === "deny";
    return Promise.resolve(
      denied
        ? {
            effect: "deny" as const,
            risk: "write" as const,
            reasons: [
              { code: "install_deny_rule" as const, stage: "install_deny" as const, message: "no" },
            ],
          }
        : {
            effect: "allow" as const,
            risk: "write" as const,
            reasons: [
              { code: "team_allow_rule" as const, stage: "user_allow" as const, message: "ok" },
            ],
          },
    );
  },
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    blobs,
    sandboxWire: {
      engine,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  listener = await sandboxListener(fx.replica(0).deps, auth);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

async function threadOf(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").thread_id;
}

async function world(): Promise<World> {
  const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`a-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    runId,
    threadId: await threadOf(team, runId),
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

/** Connects (with or without the artifacts capability) and starts the world's run. */
async function started(w: World, capabilities: readonly string[] = [CAPABILITY_ARTIFACTS]) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(w.sandboxId, [], "1.0.0", capabilities);
  await sb.ready();
  const started = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId: w.runId, threadId: w.threadId, message: "hi" },
    );
  expect(started).toEqual({ ok: true });
  return sb;
}

type Input = Record<string, unknown>;
const create = (over: Input = {}): Input => ({
  kind: "markdown",
  title: "Plan",
  content: "# Plan\nSECRET-CONTENT",
  ...over,
});

let seq = 0;
async function check(sb: FakeSandbox, w: World, callId: string, tool: string, input: Input) {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool,
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

async function put(sb: FakeSandbox, w: World, callId: string, tool: string, input: Input) {
  const request_id = `p${seq++}`;
  sb.send({
    v: 1,
    type: "artifact.put",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool,
    input,
  });
  return sb.until(
    () => sb.frames("artifact.result").find((r) => r.request_id === request_id),
    3000,
  );
}

/** policy.check (must allow) then artifact.put. */
async function allowedPut(sb: FakeSandbox, w: World, callId: string, tool: string, input: Input) {
  expect((await check(sb, w, callId, tool, input)).decision).toBe("allow");
  return put(sb, w, callId, tool, input);
}

const rows = async <T>(text: string, params: unknown[]) =>
  (await fx.admin.query(text, params)).rows as T[];

const versionCount = async (team: string) =>
  Number(
    (
      await rows<{ n: string }>(`SELECT count(*) AS n FROM artifact_versions WHERE team_id = $1`, [
        team,
      ])
    )[0]?.n,
  );

async function refusals(team: string): Promise<{ reason: string; text: string }[]> {
  // Audit rows are written off the frame path.
  await new Promise((r) => setTimeout(r, 300));
  return (
    await rows<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'sandbox.artifact_refused' ORDER BY seq`,
      [team],
    )
  ).map((r) => ({ reason: String(r.target.reason), text: JSON.stringify(r.target) }));
}

const eventTypes = async (team: string, runId: string) =>
  (
    await rows<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type LIKE 'artifact.%' ORDER BY seq`,
      [team, runId],
    )
  ).map((e) => ({ type: e.type, payload: e.payload }));

describe("artifact.put: create and update", () => {
  it("stores content in S3 under a server-derived key, versions it and emits the events", async () => {
    const w = await world();
    const sb = await started(w);
    const created = await allowedPut(sb, w, "call-1", "create_artifact", create());
    expect(created).toMatchObject({ ok: true, version: 1 });
    const artifactId = created.ok ? created.artifact_id : "";

    const [version] = await rows<{ blob_ref: string; size_bytes: string; sha256: string }>(
      `SELECT blob_ref, size_bytes, sha256 FROM artifact_versions WHERE team_id = $1 AND artifact_id = $2`,
      [w.team, artifactId],
    );
    const key = must(version, "version").blob_ref;
    expect(
      key.startsWith(`${PREFIX}teams/${w.team}/threads/${w.threadId}/artifacts/${artifactId}/`),
    ).toBe(true);
    expect(objects.objects.get(key)?.toString("utf8")).toBe("# Plan\nSECRET-CONTENT");

    const update = { artifact_id: artifactId, content: "# Plan v2", title: "Plan 2" };
    const updated = await allowedPut(sb, w, "call-2", "update_artifact", update);
    expect(updated).toMatchObject({ ok: true, artifact_id: artifactId, version: 2 });
    const [art] = await rows<{ current_version: number; title: string }>(
      `SELECT current_version, title FROM artifacts WHERE team_id = $1 AND id = $2`,
      [w.team, artifactId],
    );
    expect(art).toEqual({ current_version: 2, title: "Plan 2" });
    expect(await versionCount(w.team)).toBe(2);

    expect(await eventTypes(w.team, w.runId)).toEqual([
      {
        type: "artifact.created",
        payload: {
          artifact_id: artifactId,
          tool_call_id: "call-1",
          kind: "markdown",
          title: "Plan",
          version: 1,
        },
      },
      {
        type: "artifact.updated",
        payload: { artifact_id: artifactId, tool_call_id: "call-2", title: "Plan 2", version: 2 },
      },
    ]);
    expect(await refusals(w.team)).toEqual([]);
  });

  it("is idempotent on the tool call: a repeat returns the first result and stores nothing more", async () => {
    const w = await world();
    const sb = await started(w);
    const first = await allowedPut(sb, w, "call-1", "create_artifact", create());
    const before = objects.objects.size;
    const again = await put(sb, w, "call-1", "create_artifact", create());
    expect(again).toMatchObject({ ok: true, version: 1 });
    expect(again.ok && first.ok && again.artifact_id).toBe(first.ok && first.artifact_id);
    expect(await versionCount(w.team)).toBe(1);
    expect(objects.objects.size).toBe(before);
    expect((await eventTypes(w.team, w.runId)).length).toBe(1);
  });
});

describe("artifact.put refusals (D-3), each audited without content", () => {
  it("refuses a connection that did not announce the capability", async () => {
    const w = await world();
    const sb = await started(w, []);
    const res = await allowedPut(sb, w, "call-1", "create_artifact", create());
    expect(res).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await versionCount(w.team)).toBe(0);
    expect((await refusals(w.team)).map((r) => r.reason)).toEqual(["capability_missing"]);
  });

  it("refuses a tool call the server never allowed", async () => {
    const w = await world();
    const sb = await started(w);
    const res = await put(sb, w, "never-checked", "create_artifact", create());
    expect(res).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect((await refusals(w.team)).map((r) => r.reason)).toEqual(["not_allowed"]);
  });

  it("refuses a call the policy denied", async () => {
    const w = await world();
    const sb = await started(w);
    const input = create({ title: "deny" });
    expect((await check(sb, w, "call-1", "create_artifact", input)).decision).toBe("deny");
    expect(await put(sb, w, "call-1", "create_artifact", input)).toMatchObject({ ok: false });
    expect(await versionCount(w.team)).toBe(0);
    expect((await refusals(w.team)).map((r) => r.reason)).toEqual(["not_allowed"]);
  });

  it("refuses other input than the allowed one (even one byte), and keeps it refused", async () => {
    const w = await world();
    const sb = await started(w);
    expect((await check(sb, w, "call-1", "create_artifact", create())).decision).toBe("allow");
    const other = create({ content: "# Plan\nSECRET-CONTENT!" });
    expect(await put(sb, w, "call-1", "create_artifact", other)).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    // The input the server allowed still goes through (key order does not matter: canonical JSON).
    const reordered = { content: "# Plan\nSECRET-CONTENT", title: "Plan", kind: "markdown" };
    expect(await put(sb, w, "call-1", "create_artifact", reordered)).toMatchObject({ ok: true });
    expect((await refusals(w.team)).map((r) => r.reason)).toEqual(["input_mismatch"]);
    expect(await versionCount(w.team)).toBe(1);
  });

  it("refuses a call allowed for another tool", async () => {
    const w = await world();
    const sb = await started(w);
    const created = await allowedPut(sb, w, "call-1", "create_artifact", create());
    const id = created.ok ? created.artifact_id : "";
    const update = { artifact_id: id, content: "x" };
    // call-1 was allowed as create_artifact, not as update_artifact.
    expect(await put(sb, w, "call-1", "update_artifact", update)).toMatchObject({ ok: false });
    expect(await versionCount(w.team)).toBe(1);
    expect((await refusals(w.team)).map((r) => r.reason)).toEqual(["not_allowed"]);
  });

  it("refuses once the run has ended", async () => {
    const w = await world();
    const sb = await started(w);
    expect((await check(sb, w, "call-1", "create_artifact", create())).decision).toBe("allow");
    await fx.complete(w.team, w.runId);
    expect(await put(sb, w, "call-1", "create_artifact", create())).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    expect(await versionCount(w.team)).toBe(0);
    expect(objects.keys(`${PREFIX}teams/${w.team}/`)).toEqual([]);
    expect((await refusals(w.team)).map((r) => r.reason)).toEqual(["run_not_active"]);
  });

  it("refuses an update of an artifact of another thread, or of another team", async () => {
    const w = await world();
    const sb = await started(w);
    const created = await allowedPut(sb, w, "call-1", "create_artifact", create());
    const id = created.ok ? created.artifact_id : "";

    // Same team, other thread: a second sandbox for another run of the same user.
    const run2 = await fx.run(w.team, w.owner);
    const w2: World = {
      ...w,
      runId: run2,
      threadId: await threadOf(w.team, run2),
      sandboxId: randomUUID(),
    };
    const sb2 = await started({
      ...w2,
      token: auth.issue({ sandboxId: w2.sandboxId, teamId: w.team, userId: w.owner.id }),
    });
    const cross = await allowedPut(sb2, w2, "call-2", "update_artifact", {
      artifact_id: id,
      content: "hijack",
    });
    expect(cross).toMatchObject({ ok: false, error: { code: "not_found" } });

    // Another team entirely.
    const v = await world();
    const sbv = await started(v);
    const foreign = await allowedPut(sbv, v, "call-3", "update_artifact", {
      artifact_id: id,
      content: "hijack",
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: "not_found" } });

    expect(await versionCount(w.team)).toBe(1);
    expect(await versionCount(v.team)).toBe(0);
    expect((await refusals(w.team)).map((r) => r.reason)).toEqual(["artifact_not_found"]);
    expect((await refusals(v.team)).map((r) => r.reason)).toEqual(["artifact_not_found"]);
  });

  it("never records content in the audit rows", async () => {
    const w = await world();
    const sb = await started(w);
    await put(sb, w, "never-checked", "create_artifact", create());
    const [row] = await refusals(w.team);
    expect(must(row, "audit row").text).not.toMatch(/SECRET-CONTENT|Plan/);
  });
});

describe("/v1/artifacts", () => {
  async function seeded(kind: "html" | "svg" | "markdown", content: string) {
    const w = await world();
    const sb = await started(w);
    const res = await allowedPut(
      sb,
      w,
      "call-1",
      "create_artifact",
      create({ kind, content, title: "My Report" }),
    );
    expect(res.ok).toBe(true);
    const id = res.ok ? res.artifact_id : "";
    await allowedPut(sb, w, "call-2", "update_artifact", {
      artifact_id: id,
      content: `${content}2`,
    });
    return { w, id };
  }

  it("lists, details and serves content as an attachment", async () => {
    const { w, id } = await seeded("markdown", "# Hello");
    const b = w.owner.browser;
    const list = await b.get(`/v1/artifacts?thread_id=${w.threadId}`);
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({
      artifacts: [
        {
          id,
          thread_id: w.threadId,
          kind: "markdown",
          title: "My Report",
          current_version: 2,
          language: null,
        },
      ],
    });
    const detail = await b.get(`/v1/artifacts/${id}`);
    expect(detail.json).toMatchObject({
      id,
      versions: [
        { version: 1, size_bytes: 7 },
        { version: 2, size_bytes: 8 },
      ],
    });
    const content = await b.get(`/v1/artifacts/${id}/versions/1/content`);
    expect(content.status).toBe(200);
    expect(content.text).toBe("# Hello");
    expect(content.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("content-disposition")).toBe(
      'attachment; filename="my-report-v1.md"',
    );
    expect((await b.get(`/v1/artifacts/${id}/versions/3/content`)).status).toBe(404);
  });

  it("is readable only with the thread: other users and other teams get 404", async () => {
    const { w, id } = await seeded("markdown", "# Hello");
    const intruder = await fx.person("intruder");
    await fx.team(`i-${randomBytes(3).toString("hex")}`, intruder);
    const same = await fx.person("teammate");
    await fx.addMember(w.team, same);
    await fx.activate(same, w.team);
    for (const p of [intruder, same]) {
      expect((await p.browser.get(`/v1/artifacts/${id}`)).status).toBe(404);
      expect((await p.browser.get(`/v1/artifacts/${id}/versions/1/content`)).status).toBe(404);
      expect((await p.browser.get(`/v1/artifacts?thread_id=${w.threadId}`)).status).toBe(404);
    }
    expect((await w.owner.browser.get("/v1/artifacts/not-a-uuid")).status).toBe(400);
  });

  it("serves html in a frame with exactly the D-6 headers, and wraps svg", async () => {
    const { w, id } = await seeded("html", "<h1>hi</h1><script>1</script>");
    const res = await w.owner.browser.get(`/v1/artifacts/${id}/versions/1/frame?team=${w.team}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe("<h1>hi</h1><script>1</script>");
    const header = (name: string) => res.headers.get(name);
    expect(header("content-type")).toBe("text/html; charset=utf-8");
    expect(header("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; " +
        "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    expect(header("x-frame-options")).toBe("SAMEORIGIN");
    expect(header("referrer-policy")).toBe("no-referrer");
    expect(header("cache-control")).toBe("private, no-store");
    expect(header("x-content-type-options")).toBe("nosniff");
    // X-Frame-Options is on this route only.
    const content = await w.owner.browser.get(`/v1/artifacts/${id}/versions/1/content`);
    expect(content.headers.get("x-frame-options")).toBeNull();

    const svg = await seeded("svg", "<svg/>");
    const wrapped = await svg.w.owner.browser.get(
      `/v1/artifacts/${svg.id}/versions/1/frame?team=${svg.w.team}`,
    );
    expect(wrapped.text).toMatch(/^<!doctype html>.*<body><svg\/><\/body><\/html>$/);
    expect(wrapped.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("refuses frames for other kinds, a stale team, and cross-site navigations", async () => {
    const { w, id } = await seeded("markdown", "# Hello");
    const b = w.owner.browser;
    expect((await b.get(`/v1/artifacts/${id}/versions/1/frame?team=${w.team}`)).status).toBe(400);
    const html = await seeded("html", "<p>x</p>");
    const url = `/v1/artifacts/${html.id}/versions/1/frame`;
    const hb = html.w.owner.browser;
    const stale = await hb.get(`${url}?team=${randomUUID()}`);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "team_mismatch", activeTeamId: html.w.team });
    expect(
      (await hb.get(`${url}?team=${html.w.team}`, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (await hb.get(`${url}?team=${html.w.team}`, { "sec-fetch-site": "same-origin" })).status,
    ).toBe(200);
  });
});

describe("retention and export", () => {
  it("export writes artifacts/<id>/v<n>.<ext>; purge queues the blobs and removes the rows", async () => {
    const w = await world();
    const sb = await started(w);
    const created = await allowedPut(
      sb,
      w,
      "call-1",
      "create_artifact",
      create({ kind: "code", language: "python", content: "print(1)" }),
    );
    const id = created.ok ? created.artifact_id : "";
    await allowedPut(sb, w, "call-2", "update_artifact", { artifact_id: id, content: "print(2)" });
    const db = fx.db;

    const chunks: Uint8Array[] = [];
    for await (const c of exportZip(db, { teamId: w.team, userId: w.owner.id }, blobs))
      chunks.push(c);
    const files = unzipSync(Buffer.concat(chunks));
    expect(strFromU8(files[`artifacts/${id}/v1.py`] ?? new Uint8Array())).toBe("print(1)");
    expect(strFromU8(files[`artifacts/${id}/v2.py`] ?? new Uint8Array())).toBe("print(2)");

    const keys = objects.keys(`${PREFIX}teams/${w.team}/threads/${w.threadId}/artifacts/`);
    expect(keys).toHaveLength(2);
    await fx.complete(w.team, w.runId);
    const outcome = await purgeThreads(
      db,
      w.team,
      { kind: "user", userId: w.owner.id },
      async () => {},
    );
    expect(outcome).toMatchObject({ status: "done", counts: { threads: 1, blobs: 2 } });
    expect(await versionCount(w.team)).toBe(0);
    expect(await rows(`SELECT 1 FROM artifacts WHERE team_id = $1`, [w.team])).toEqual([]);
    await deleteReleasedBlobs(db, w.team, blobs, blobRecorder(w.team), { maxBatches: 5 });
    expect(objects.keys(`${PREFIX}teams/${w.team}/`)).toEqual([]);
  });
});
