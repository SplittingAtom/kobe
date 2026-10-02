import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createIsolationGate } from "./isolation/gate.js";
import type { RuntimeClassLike } from "./isolation/runtime-class.js";

const gateWith = (list: () => Promise<readonly RuntimeClassLike[]>) =>
  createIsolationGate({ runtimeClassName: "gvisor", listRuntimeClasses: list });

describe("/readyz with the isolation gate", () => {
  it("is not ready until the startup check has completed", async () => {
    const app = createApp(undefined, { isolation: gateWith(() => new Promise(() => {})) });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "starting",
      service: "server",
      isolation: "checking",
    });
  });

  it("reports verified isolation", async () => {
    const gate = gateWith(async () => [{ metadata: { name: "gvisor" }, handler: "runsc" }]);
    await gate.check();
    const res = await createApp(undefined, { isolation: gate }).request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", service: "server", isolation: "verified" });
  });

  it("stays ready without isolation so the admin console can show the fix", async () => {
    const gate = gateWith(async () => []);
    await gate.check();
    const res = await createApp(undefined, { isolation: gate }).request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", service: "server", isolation: "missing" });
  });
});
