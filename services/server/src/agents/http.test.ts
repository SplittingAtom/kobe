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
  it("distinguishes a missing header from an explicit *", async () => {
    expect(await ifMatch()).toEqual({ kind: "missing" });
    expect(await ifMatch("*")).toEqual({ kind: "any" });
  });

  it("reads strong and weak ETags", async () => {
    expect(await ifMatch('"7"')).toEqual({ kind: "revision", revision: 7 });
    expect(await ifMatch('W/"7"')).toEqual({ kind: "revision", revision: 7 });
  });

  it("flags anything else as invalid", async () => {
    for (const bad of ["7", '"x"', '"1", "2"', `"${"9".repeat(12)}"`]) {
      expect(await ifMatch(bad)).toEqual({ kind: "invalid" });
    }
  });
});
