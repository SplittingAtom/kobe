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
    expect(await res.json()).toEqual({ status: "starting", service: "server" });
  });

  it("is ready once isolation is verified", async () => {
    const gate = gateWith(async () => [{ metadata: { name: "gvisor" }, handler: "runsc" }]);
    await gate.check();
    const res = await createApp(undefined, { isolation: gate }).request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", service: "server" });
  });

  it("stays ready without isolation (admin console shows the fix) and does not disclose it", async () => {
    const gate = gateWith(async () => []);
    await gate.check();
    const res = await createApp(undefined, { isolation: gate }).request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", service: "server" });
  });
});
