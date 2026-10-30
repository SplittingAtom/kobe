import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { InMemorySpanExporter, SpanStatusCode, initTelemetry } from "@kobe/telemetry";
import { WORKSPACE_SYNC_PATH } from "@kobe/protocol";
import { createApp } from "./app.js";
import { createSandboxApp } from "./routes/sandbox.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandboxAuth } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import { KEYS } from "./testing/sandbox-fixtures.js";
import {
  createSandboxAuthenticator,
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";
import { WRITE_ATTR, WRITE_SPAN } from "./workspace-sync/write-spans.js";

/**
 * KOBE-529: the three workspace write routes record child spans under their server span that
 * split object-store time (`workspace.s3_put`) from Postgres (`workspace.reserve_tx`,
 * `workspace.blob_tx`, `workspace.manifest_tx` with `workspace.lock_wait` inside), against a real
 * Postgres and an in-memory object store.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 64 * 1024, maxWorkspaceBytes: 256 * 1024, maxFiles: 50 };
const exporter = new InMemorySpanExporter();
let telemetry: ReturnType<typeof initTelemetry>;
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;
let sandboxApp: ReturnType<typeof createSandboxApp>;

beforeAll(async () => {
  await fx.setup([{}]);
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
  });
  sandboxApp = createSandboxApp({
    provider: { identifyBootstrapToken: () => Promise.reject(new Error("unused")) },
    sessionKeys: KEYS,
    workspace: sync.routes(
      createSandboxAuthenticator({ db: fx.db, verify: auth.verify, liveness: auth.liveness }),
    ),
  });
  telemetry = initTelemetry(
    {
      enabled: true,
      endpoint: "http://x:4318",
      headers: {},
      captureContent: false,
      serviceName: "t",
    },
    { exporter },
  );
});

afterAll(async () => {
  await telemetry.shutdown();
  await fx.teardown();
});

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function member(): Promise<{ team: string; person: Person; browser: TestBrowser }> {
  const person = await fx.person(`ws${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`wsp-${randomBytes(3).toString("hex")}`, person);
  const browser = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of person.browser.cookies) browser.cookies.set(k, v);
  browser.team = team;
  return { team, person, browser };
}

/** The finished spans of the one trace whose server span has `route`. */
function traceOf(route: string) {
  const all = exporter.getFinishedSpans();
  const server = all.filter((s) => s.attributes["http.route"] === route).at(-1);
  expect(server).toBeDefined();
  const traceId = server?.spanContext().traceId;
  return { server, spans: all.filter((s) => s.spanContext().traceId === traceId) };
}

function multipart(name: string, data: string) {
  const boundary = `----kobe${randomBytes(6).toString("hex")}`;
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${data}\r\n--${boundary}--\r\n`,
  );
  return {
    raw: new RawBody(body, `multipart/form-data; boundary=${boundary}`),
    headers: { "content-length": String(body.length) },
  };
}

describe("workspace write spans (KOBE-529)", () => {
  it("POST /v1/workspace/files: stream, reserve, copy, blob and manifest under the request", async () => {
    exporter.reset();
    const m = await member();
    const m2 = multipart("secret-name.txt", "hello upload");
    const res = await m.browser.request("POST", "/v1/workspace/files", m2.raw, m2.headers);
    expect(res.status).toBe(201);
    const { server, spans } = traceOf("/v1/workspace/files");
    const children = spans.filter((s) => s.name.startsWith("workspace."));
    const ops = children
      .filter((s) => s.name === WRITE_SPAN.s3Put)
      .map((s) => s.attributes[WRITE_ATTR.s3Op]);
    expect(ops).toEqual(["stream", "copy", "delete"]);
    const manifest = children.find((s) => s.name === WRITE_SPAN.manifestTx);
    expect(manifest?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
    expect(manifest?.attributes[WRITE_ATTR.outcome]).toBe("ok");
    const locks = children.filter((s) => s.name === WRITE_SPAN.lockWait);
    expect(locks.map((s) => s.attributes[WRITE_ATTR.lock])).toEqual(["workspace", "team_storage"]);
    for (const l of locks) expect(l.parentSpanContext?.spanId).toBe(manifest?.spanContext().spanId);
    expect(children.some((s) => s.name === WRITE_SPAN.blobTx)).toBe(true);
    expect(children.filter((s) => s.name === WRITE_SPAN.reserveTx)).toHaveLength(2);
    for (const s of children) expect(s.attributes[WRITE_ATTR.kind]).toBe("upload");
    const text = JSON.stringify(children.map((s) => s.attributes));
    expect(text).not.toContain("secret-name");
    expect(text).not.toContain(m.team);
  });

  it("PUT /v1/workspace/file: put, blob and manifest; a stale base is a version_conflict", async () => {
    const m = await member();
    const owner = { teamId: m.team, userId: m.person.id };
    const data = Buffer.from("v1");
    const key = workspaceBlobKey("", owner, sha(data));
    objects.objects.set(key, data);
    await withTeam(fx.db, m.team, (tx) =>
      sync.putServerFile(
        tx,
        owner,
        { path: "a.txt", sha256: sha(data), size: 2, blobKey: key },
        "user",
      ),
    );
    const save = (base: string, body: string) =>
      m.browser.put(
        `/v1/workspace/file?path=a.txt&base_sha256=${base}`,
        new RawBody(body, "text/plain; charset=utf-8"),
      );

    exporter.reset();
    expect((await save(sha(data), "v2")).status).toBe(200);
    const ok = traceOf("/v1/workspace/file").spans;
    const put = ok.find((s) => s.name === WRITE_SPAN.s3Put);
    expect(put?.attributes).toEqual({ [WRITE_ATTR.kind]: "save", [WRITE_ATTR.s3Op]: "put" });
    const manifest = ok.find((s) => s.name === WRITE_SPAN.manifestTx);
    expect(manifest?.attributes[WRITE_ATTR.outcome]).toBe("ok");
    expect(ok.filter((s) => s.name === WRITE_SPAN.lockWait)).toHaveLength(2);

    exporter.reset();
    expect((await save(sha(data), "v3")).status).toBe(409);
    const stale = traceOf("/v1/workspace/file").spans;
    const reserve = stale.find((s) => s.name === WRITE_SPAN.reserveTx);
    expect(reserve?.attributes[WRITE_ATTR.outcome]).toBe("version_conflict");
    expect(stale.some((s) => s.name === WRITE_SPAN.s3Put)).toBe(false);
  });

  it("PUT /v1/sandbox/workspace/blobs/:sha256: reserve, put, blob; a failed put is flagged", async () => {
    const m = await member();
    const sandboxId = randomUUID();
    const token = auth.issue({ sandboxId, teamId: m.team, userId: m.person.id });
    const putBlob = (data: Buffer, hash = sha(data)) =>
      sandboxApp.request(`${WORKSPACE_SYNC_PATH}/blobs/${hash}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-length": String(data.length) },
        body: new Uint8Array(data),
      });

    exporter.reset();
    expect((await putBlob(Buffer.from("blob one"))).status).toBe(201);
    const ok = traceOf("/v1/sandbox/workspace/blobs/:sha256");
    const names = ok.spans.filter((s) => s.name.startsWith("workspace.")).map((s) => s.name);
    expect(names).toEqual([WRITE_SPAN.reserveTx, WRITE_SPAN.s3Put, WRITE_SPAN.blobTx]);
    for (const s of ok.spans.filter((x) => x.name.startsWith("workspace."))) {
      expect(s.parentSpanContext?.spanId).toBe(ok.server?.spanContext().spanId);
      expect(s.attributes[WRITE_ATTR.kind]).toBe("blob");
    }
    const blobTx = ok.spans.find((s) => s.name === WRITE_SPAN.blobTx);
    expect(blobTx?.attributes[WRITE_ATTR.outcome]).toBe("added");

    exporter.reset();
    const wrong = Buffer.from("not what the name says");
    expect((await putBlob(wrong, sha("other"))).status).toBe(422);
    const failed = traceOf("/v1/sandbox/workspace/blobs/:sha256").spans;
    const put = failed.find((s) => s.name === WRITE_SPAN.s3Put);
    expect(put?.status.code).toBe(SpanStatusCode.ERROR);
    expect(put?.attributes["error.type"]).toBeDefined();
  });
});
