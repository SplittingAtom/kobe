import { InMemorySpanExporter, SpanStatusCode, initTelemetry, withSpan } from "@kobe/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WRITE_ATTR, WRITE_SPAN, lockWaitSpan, s3PutSpan, writeTxSpan } from "./write-spans.js";

/** KOBE-529: the child spans that split a workspace write's time (object store vs Postgres). */
let exporter: InMemorySpanExporter;
let telemetry: ReturnType<typeof initTelemetry>;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
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
afterEach(() => telemetry.shutdown());

const spans = () => exporter.getFinishedSpans();
const named = (name: string) => spans().find((s) => s.name === name);

/** Runs `fn` under a parent span and returns the parent's span id. */
async function underParent(fn: () => Promise<unknown>): Promise<string> {
  let id = "";
  await withSpan("http.request", {}, async (span) => {
    id = span.spanContext().spanId;
    await fn().catch(() => undefined);
  });
  return id;
}

describe("workspace write spans (KOBE-529)", () => {
  it("workspace.s3_put: child of the request, kind and operation, no error on success", async () => {
    const parent = await underParent(() => s3PutSpan("blob", "put", () => Promise.resolve()));
    const span = named(WRITE_SPAN.s3Put);
    expect(span?.parentSpanContext?.spanId).toBe(parent);
    expect(span?.attributes).toEqual({ [WRITE_ATTR.kind]: "blob", [WRITE_ATTR.s3Op]: "put" });
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("workspace.s3_put: a failed put is flagged with the error type only", async () => {
    await underParent(() =>
      s3PutSpan("drop", "stream", () => Promise.reject(new TypeError("s3://bucket/secret path"))),
    );
    const span = named(WRITE_SPAN.s3Put);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("TypeError");
    expect(JSON.stringify(span?.attributes)).not.toContain("secret");
  });

  it("workspace.manifest_tx: the outcome comes from the result, the value passes through", async () => {
    let result: unknown;
    const parent = await underParent(async () => {
      result = await writeTxSpan(
        WRITE_SPAN.manifestTx,
        "save",
        () => Promise.resolve({ ok: false, code: "version_conflict" }),
        (r) => (r.ok ? "ok" : r.code),
      );
    });
    const span = named(WRITE_SPAN.manifestTx);
    expect(result).toEqual({ ok: false, code: "version_conflict" });
    expect(span?.parentSpanContext?.spanId).toBe(parent);
    expect(span?.attributes).toEqual({
      [WRITE_ATTR.kind]: "save",
      [WRITE_ATTR.outcome]: "version_conflict",
    });
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("workspace.manifest_tx: a thrown transaction is an error with outcome `error`", async () => {
    await underParent(() =>
      writeTxSpan(
        WRITE_SPAN.manifestTx,
        "upload",
        () => Promise.reject(new Error("x")),
        () => "ok",
      ),
    );
    const span = named(WRITE_SPAN.manifestTx);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes[WRITE_ATTR.outcome]).toBe("error");
  });

  it("workspace.reserve_tx and workspace.blob_tx carry kind and outcome", async () => {
    await underParent(async () => {
      await writeTxSpan(WRITE_SPAN.reserveTx, "blob", () => Promise.resolve("reserved"), String);
      await writeTxSpan(WRITE_SPAN.blobTx, "blob", () => Promise.resolve("added"), String);
    });
    expect(named(WRITE_SPAN.reserveTx)?.attributes[WRITE_ATTR.outcome]).toBe("reserved");
    expect(named(WRITE_SPAN.blobTx)?.attributes[WRITE_ATTR.outcome]).toBe("added");
  });

  it("workspace.lock_wait nests inside the transaction span and names the lock", async () => {
    await underParent(() =>
      writeTxSpan(
        WRITE_SPAN.manifestTx,
        "artifact",
        () => lockWaitSpan("artifact", "workspace", () => Promise.resolve(1)),
        () => "ok",
      ),
    );
    const tx = named(WRITE_SPAN.manifestTx);
    const lock = named(WRITE_SPAN.lockWait);
    expect(lock?.parentSpanContext?.spanId).toBe(tx?.spanContext().spanId);
    expect(lock?.attributes).toEqual({
      [WRITE_ATTR.kind]: "artifact",
      [WRITE_ATTR.lock]: "workspace",
    });
  });

  it("an outcome outside the allowed shape is recorded as `other`", async () => {
    await underParent(() =>
      writeTxSpan(WRITE_SPAN.blobTx, "blob", () => Promise.resolve("a/b c"), String),
    );
    expect(named(WRITE_SPAN.blobTx)?.attributes[WRITE_ATTR.outcome]).toBe("other");
  });

  it("records nothing and still runs when tracing is off", async () => {
    await telemetry.shutdown();
    telemetry = initTelemetry(
      { enabled: false, endpoint: "", headers: {}, captureContent: false, serviceName: "t" },
      { exporter },
    );
    expect(await s3PutSpan("blob", "put", () => Promise.resolve(7))).toBe(7);
    expect(spans()).toHaveLength(0);
  });
});
