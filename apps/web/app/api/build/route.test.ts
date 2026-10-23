import { describe, expect, it } from "vitest";
import { CLIENT_BUILD_ID } from "../../../lib/build/build-id";
import { GET } from "./route";

describe("web /api/build (KOBE-487)", () => {
  it("reports the running build's id, never cached", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ buildId: CLIENT_BUILD_ID });
  });
});
