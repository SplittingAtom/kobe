import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables, InstallRole } from "../auth/session.js";
import { createIsolationGate, type IsolationGate } from "../isolation/gate.js";
import type { RuntimeClassLike } from "../isolation/runtime-class.js";
import { installIsolationRoutes } from "./install-isolation.js";

const at = new Date("2026-10-02T00:00:00Z");

function mount(isolation: IsolationGate, installRole: InstallRole) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(async (c, next) => {
    c.set("installRole", installRole);
    await next();
  });
  app.route("/v1/install/isolation", installIsolationRoutes(isolation));
  return app;
}

const gateWith = (classes: readonly RuntimeClassLike[]) =>
  createIsolationGate({
    runtimeClassName: "gvisor",
    listRuntimeClasses: async () => classes,
    now: () => at,
  });

describe("GET /v1/install/isolation (admin console)", () => {
  it("is for install admins only", async () => {
    const res = await mount(gateWith([]), null).request("/v1/install/isolation");
    expect(res.status).toBe(403);
  });

  it("shows the verified RuntimeClass", async () => {
    const gate = gateWith([{ metadata: { name: "gvisor" }, handler: "runsc" }]);
    await gate.check();
    const res = await mount(gate, "admin").request("/v1/install/isolation");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "verified",
      agentsEnabled: true,
      runtimeClassName: "gvisor",
      handler: "runsc",
      checkedAt: at.toISOString(),
    });
  });

  it("shows the problem and the fix when isolation is missing", async () => {
    const gate = gateWith([{ metadata: { name: "gvisor" }, handler: "runc" }]);
    await gate.check();
    const res = await mount(gate, "owner").request("/v1/install/isolation");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      state: "missing",
      agentsEnabled: false,
      runtimeClassName: "gvisor",
      checkedAt: at.toISOString(),
      docs: "docs/install.md#isolation",
    });
    expect(body.message).toMatch(/handler "runc".*install-gvisor-k3s\.sh/);
  });

  it("reports agents disabled while the first check is pending", async () => {
    const body = await (await mount(gateWith([]), "admin").request("/v1/install/isolation")).json();
    expect(body).toEqual({ state: "checking", agentsEnabled: false, runtimeClassName: "gvisor" });
  });
});

describe("POST /v1/install/isolation/check", () => {
  it("re-checks now, so a fixed cluster enables agents without waiting", async () => {
    let classes: readonly RuntimeClassLike[] = [];
    const list = vi.fn(async () => classes);
    const gate = createIsolationGate({ runtimeClassName: "gvisor", listRuntimeClasses: list });
    await gate.check();
    classes = [{ metadata: { name: "gvisor" }, handler: "runsc" }];
    const res = await mount(gate, "admin").request("/v1/install/isolation/check", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "verified", agentsEnabled: true });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("is for install admins only", async () => {
    const list = vi.fn(async () => []);
    const gate = createIsolationGate({ runtimeClassName: "gvisor", listRuntimeClasses: list });
    const res = await mount(gate, null).request("/v1/install/isolation/check", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});
