import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("web /api/healthz", () => {
  it("reports the web app as alive", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "web" });
  });
});
