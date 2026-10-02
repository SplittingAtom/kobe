import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("server health endpoints", () => {
  const app = createApp();

  it("GET /healthz reports the service as alive", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "server" });
  });

  it("GET /readyz reports the service as ready", async () => {
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", service: "server" });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
