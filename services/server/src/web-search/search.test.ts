import { describe, expect, it } from "vitest";
import { searchProvider } from "./search.js";

type Call = { url: string; init: RequestInit };
function fakeFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const KEY = "secret-key-123456";
const header = (c: Call | undefined, name: string) =>
  (c?.init.headers as Record<string, string> | undefined)?.[name];

describe("searchProvider", () => {
  it("brave: GET with the token header, strips markup, keeps title url snippet", async () => {
    const { fetchFn, calls } = fakeFetch({
      web: {
        results: [
          {
            title: "A <b>b</b>",
            url: "https://a.example/x",
            description: "d <strong>1</strong> &amp; 2",
          },
          { title: "bad", url: "javascript:alert(1)", description: "x" },
        ],
      },
    });
    const out = await searchProvider("brave", KEY, { query: "q & r", count: 2 }, fetchFn);
    expect(out).toEqual({
      ok: true,
      results: [{ title: "A b", url: "https://a.example/x", snippet: "d 1 & 2" }],
    });
    expect(calls[0]?.url).toBe("https://api.search.brave.com/res/v1/web/search?q=q+%26+r&count=2");
    expect(header(calls[0], "X-Subscription-Token")).toBe(KEY);
  });

  it("tavily: POST with a bearer key", async () => {
    const { fetchFn, calls } = fakeFetch({
      results: [{ title: "T", url: "https://t.example", content: "c" }],
    });
    const out = await searchProvider("tavily", KEY, { query: "q" }, fetchFn);
    expect(out).toMatchObject({ ok: true, results: [{ title: "T", snippet: "c" }] });
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect(header(calls[0], "Authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({ query: "q", max_results: 5 });
  });

  it("exa: POST with x-api-key", async () => {
    const { fetchFn, calls } = fakeFetch({
      results: [{ title: null, url: "https://e.example", text: "body text" }],
    });
    const out = await searchProvider("exa", KEY, { query: "q", count: 1 }, fetchFn);
    expect(out).toMatchObject({
      ok: true,
      results: [{ title: "https://e.example", url: "https://e.example", snippet: "body text" }],
    });
    expect(header(calls[0], "x-api-key")).toBe(KEY);
  });

  it("truncates long fields", async () => {
    const { fetchFn } = fakeFetch({
      results: [{ title: "t".repeat(900), url: "https://t.example", content: "c".repeat(5000) }],
    });
    const out = await searchProvider("tavily", KEY, { query: "q" }, fetchFn);
    if (!out.ok) throw new Error("expected ok");
    expect(out.results[0]?.title.length).toBeLessThanOrEqual(300);
    expect(out.results[0]?.snippet.length).toBeLessThanOrEqual(1000);
  });

  it.each([401, 429, 500])(
    "fails with search_failed on HTTP %i without leaking the key",
    async (status) => {
      const { fetchFn } = fakeFetch(`nope ${KEY}`, status);
      const out = await searchProvider("brave", KEY, { query: "q" }, fetchFn);
      expect(out).toMatchObject({
        ok: false,
        code: status === 429 ? "rate_limited" : "search_failed",
      });
      expect(JSON.stringify(out)).not.toContain(KEY);
    },
  );

  it("fails on malformed JSON, network errors and oversize bodies", async () => {
    expect(
      await searchProvider("brave", KEY, { query: "q" }, fakeFetch("not json").fetchFn),
    ).toMatchObject({ ok: false });
    const boom = (() => Promise.reject(new Error(`down ${KEY}`))) as unknown as typeof fetch;
    const out = await searchProvider("brave", KEY, { query: "q" }, boom);
    expect(out).toMatchObject({ ok: false, code: "search_failed" });
    expect(JSON.stringify(out)).not.toContain(KEY);
    const big = fakeFetch("x".repeat(2 * 1024 * 1024)).fetchFn;
    expect(await searchProvider("brave", KEY, { query: "q" }, big)).toMatchObject({ ok: false });
  });
});
