import { describe, expect, it, vi } from "vitest";
import { llmsFullTxt as pkgFull, llmsTxt as pkgIndex, pageMarkdown as pkgPage } from "@kobe/guide";
import { GET as getFull } from "../../app/llms-full.txt/route";
import { GET as getIndex } from "../../app/llms.txt/route";
import { GET as getPage } from "../../app/guide-md/[...slug]/route";
import { PAGES } from "./guide";
import { etagOf, textResponse } from "./llms";

/**
 * KOBE-616 (ac-4) HTTP side; KOBE-620 (KA-3 ac-1): the routes answer exactly the `@kobe/guide`
 * texts (byte-equal) for the deployment's origin and app name, the same ones the server's docs
 * tools return. The texts' own format is tested in packages/guide.
 */
const CTX = { appName: "Acme Chat", origin: "https://chat.example.com" };
vi.mock("./routes", () => ({ llmsContext: async () => CTX }));

describe("the guide routes serve the shared texts", () => {
  it("/llms.txt and /llms-full.txt", async () => {
    const index = await getIndex(new Request("https://x/llms.txt"));
    expect(await index.text()).toBe(pkgIndex(PAGES, CTX));
    const full = await getFull(new Request("https://x/llms-full.txt"));
    expect(await full.text()).toBe(pkgFull(PAGES, CTX));
  });

  it("/docs/<slug>.md for every page, 404 for anything else", async () => {
    for (const page of PAGES) {
      const res = await getPage(new Request(`https://x/docs/${page.slug}.md`), {
        params: Promise.resolve({ slug: `${page.slug}.md`.split("/") }),
      });
      expect(await res.text()).toBe(pkgPage(page, CTX.origin));
    }
    const missing = await getPage(new Request("https://x/docs/nope.md"), {
      params: Promise.resolve({ slug: ["nope.md"] }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("textResponse", () => {
  it("is utf-8 text, cacheable, with an ETag that answers 304", async () => {
    const res = textResponse(new Request("https://x/llms.txt"), "hello", "text/plain");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toMatch(/^public, max-age=\d+/);
    expect(res.headers.get("etag")).toBe(etagOf("hello"));
    expect(await res.text()).toBe("hello");
    const again = textResponse(
      new Request("https://x/llms.txt", { headers: { "if-none-match": etagOf("hello") } }),
      "hello",
      "text/markdown",
    );
    expect(again.status).toBe(304);
    expect(etagOf("hello")).not.toBe(etagOf("hellp"));
  });
});
