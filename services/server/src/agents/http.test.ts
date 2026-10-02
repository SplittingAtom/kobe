import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { readIfMatch } from "./http.js";

async function ifMatch(header?: string) {
  const app = new Hono();
  app.get("/", (c) => c.json(readIfMatch(c)));
  const res = await app.request(
    "/",
    header === undefined ? {} : { headers: { "if-match": header } },
  );
  return res.json();
}

describe("readIfMatch", () => {
  it("treats a missing header or * as any revision", async () => {
    expect(await ifMatch()).toEqual({ ok: true });
    expect(await ifMatch("*")).toEqual({ ok: true });
  });

  it("reads strong and weak ETags", async () => {
    expect(await ifMatch('"7"')).toEqual({ ok: true, revision: 7 });
    expect(await ifMatch('W/"7"')).toEqual({ ok: true, revision: 7 });
  });

  it("refuses anything else (it can't match)", async () => {
    for (const bad of ["7", '"x"', '"1", "2"', `"${"9".repeat(12)}"`]) {
      expect(await ifMatch(bad)).toEqual({ ok: false });
    }
  });
});
