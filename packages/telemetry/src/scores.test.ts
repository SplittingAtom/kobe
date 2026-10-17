import { describe, expect, it } from "vitest";
import { createLangfuseScoreSink, langfuseScoresUrl, type TraceScore } from "./scores.js";

const SCORE: TraceScore = {
  id: "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11",
  traceId: "0b6f0d4e5a3c4d8e9a435f7b0f2d1c11",
  name: "answer_feedback",
  dataType: "BOOLEAN",
  value: 0,
  metadata: { reasons: ["wrong"] },
};

function recorder(status = 200) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
    [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const config = (endpoint: string) => ({
  enabled: true,
  endpoint,
  headers: { Authorization: "Basic cGs6c2s=" },
});

describe("langfuseScoresUrl (KOBE-275)", () => {
  it("derives the scores API from a Langfuse OTLP endpoint", () => {
    expect(langfuseScoresUrl("https://lf.example/api/public/otel")).toBe(
      "https://lf.example/api/public/scores",
    );
    expect(langfuseScoresUrl("http://lf-web.lf.svc:3000/sub/api/public/otel/")).toBe(
      "http://lf-web.lf.svc:3000/sub/api/public/scores",
    );
  });

  it("is off for any other backend and without an endpoint", () => {
    expect(langfuseScoresUrl("http://otel-collector:4318")).toBeUndefined();
    expect(langfuseScoresUrl("http://phoenix:6006")).toBeUndefined();
    expect(langfuseScoresUrl(undefined)).toBeUndefined();
    expect(createLangfuseScoreSink(config("http://otel-collector:4318"))).toBeUndefined();
    expect(
      createLangfuseScoreSink({ ...config("https://lf.example/api/public/otel"), enabled: false }),
    ).toBeUndefined();
  });
});

describe("createLangfuseScoreSink", () => {
  it("posts the score with the exporter's headers and deletes by id", async () => {
    const { calls, fetchFn } = recorder();
    const sink = createLangfuseScoreSink(config("https://lf.example/api/public/otel"), {
      fetch: fetchFn,
    });
    await sink?.upsert(SCORE);
    await sink?.remove(SCORE.id);
    expect(calls).toEqual([
      {
        url: "https://lf.example/api/public/scores",
        method: "POST",
        headers: { Authorization: "Basic cGs6c2s=", "content-type": "application/json" },
        body: JSON.stringify(SCORE),
      },
      {
        url: `https://lf.example/api/public/scores/${SCORE.id}`,
        method: "DELETE",
        headers: { Authorization: "Basic cGs6c2s=" },
      },
    ]);
  });

  it("treats a missing score as removed and fails other answers with the status only", async () => {
    const gone = recorder(404);
    const sink = createLangfuseScoreSink(config("https://lf.example/api/public/otel"), {
      fetch: gone.fetchFn,
    });
    await expect(sink?.remove(SCORE.id)).resolves.toBeUndefined();
    await expect(sink?.upsert(SCORE)).rejects.toThrow("trace score upsert failed (HTTP 404)");
    const down = createLangfuseScoreSink(config("https://lf.example/api/public/otel"), {
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED with Basic cGs6c2s=");
      }) as typeof fetch,
    });
    const err = await down?.upsert(SCORE).catch((e: unknown) => e);
    expect(String(err)).toBe("ScoreExportError: trace score upsert failed");
  });
});
