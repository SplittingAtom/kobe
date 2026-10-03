import { AUDIT_EVENTS } from "@kobe/db";
import { describe, expect, it, vi } from "vitest";
import { IsolationRuntimeMissingError, type IsolationGate } from "../isolation/gate.js";
import { createFakeKube, simulateAgentSandbox, type FakeKube } from "../testing/fake-kube.js";
import { SETTINGS, TEAM, USER, gateFor, must, seedCluster } from "../testing/sandbox-fixtures.js";
import type { SandboxSettings } from "./config.js";
import {
  createSandboxProvider,
  type SandboxAuditEvent,
  type SandboxProviderOptions,
} from "./provider.js";

/** Hibernate and wake (KOBE-25, spec D14) against the fake cluster + agent-sandbox simulation. */
const NS = "kobe-team-finance";

function setup(
  opts: {
    controller?: Parameters<typeof simulateAgentSandbox>[1];
    gate?: Pick<IsolationGate, "require">;
    provider?: Partial<SandboxProviderOptions>;
  } = {},
) {
  const kube = createFakeKube();
  seedCluster(kube);
  simulateAgentSandbox(kube, opts.controller ?? {});
  const gate = opts.gate ?? gateFor(kube);
  const audits: SandboxAuditEvent[] = [];
  const make = (settings: SandboxSettings = SETTINGS) =>
    createSandboxProvider({
      kube,
      isolation: gate,
      settings,
      sleep: async () => kube.finishTermination?.(),
      audit: (e) => void audits.push(e),
      ...opts.provider,
    });
  return { kube, gate, audits, provider: make(), make };
}

const sandboxOf = (kube: FakeKube, name: string) =>
  must(kube.peek({ apiVersion: "agents.x-k8s.io/v1beta1", kind: "Sandbox", name, namespace: NS }));
const podOf = (kube: FakeKube, name: string) =>
  kube.peek({ apiVersion: "v1", kind: "Pod", name, namespace: NS });
const mode = (kube: FakeKube, name: string) =>
  (sandboxOf(kube, name).spec as { operatingMode: string }).operatingMode;
const podSpec = (kube: FakeKube, name: string) =>
  (sandboxOf(kube, name).spec as { podTemplate: { spec: Record<string, unknown> } }).podTemplate
    .spec;

describe("hibernateSandbox (D14)", () => {
  it("suspends the Sandbox: its pod goes, the claim (and with it the volume) stays", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    await expect(provider.hibernateSandbox(TEAM, USER, handle.sandboxId)).resolves.toBe(
      "suspended",
    );
    expect(mode(kube, handle.sandboxName)).toBe("Suspended");
    expect(podOf(kube, handle.sandboxName)).toBeUndefined();
    expect(kube.all("SandboxClaim")).toHaveLength(1);
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({
      state: "suspended",
    });
  });

  it("is idempotent and never touches another sandbox", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    await provider.hibernateSandbox(TEAM, USER, handle.sandboxId);
    await expect(provider.hibernateSandbox(TEAM, USER, handle.sandboxId)).resolves.toBe(
      "already_suspended",
    );
    // A stale sandbox id (the claim was recreated since) names nothing.
    await expect(
      provider.hibernateSandbox(TEAM, USER, "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f"),
    ).resolves.toBe("not_found");
    expect(kube.calls.filter((c) => c.verb === "patch")).toHaveLength(1);
  });

  it("needs no isolation check (stopping a pod is always safe)", async () => {
    const require = vi.fn(async () => {
      throw new IsolationRuntimeMissingError("gone");
    });
    const { kube, provider: creator } = setup();
    const handle = await creator.ensureSandbox(TEAM, USER);
    const provider = createSandboxProvider({
      kube,
      isolation: { require },
      settings: SETTINGS,
      sleep: async () => {},
    });
    await expect(provider.hibernateSandbox(TEAM, USER, handle.sandboxId)).resolves.toBe(
      "suspended",
    );
    expect(require).not.toHaveBeenCalled();
  });

  it("re-reads and retries when the Sandbox changed under it (409)", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    kube.failNext("patch", "Sandbox", 409);
    await expect(provider.hibernateSandbox(TEAM, USER, handle.sandboxId)).resolves.toBe(
      "suspended",
    );
  });
});

describe("wakeSandbox (D14, KOBE-9)", () => {
  async function hibernated(opts: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(opts);
    const handle = await ctx.provider.ensureSandbox(TEAM, USER);
    await ctx.provider.hibernateSandbox(TEAM, USER, handle.sandboxId);
    ctx.kube.calls.length = 0;
    return { ...ctx, handle };
  }

  it("resumes a hibernated sandbox and returns its new pod", async () => {
    const { kube, provider, handle, audits } = await hibernated();
    const woken = await provider.wakeSandbox(TEAM, USER);
    expect(woken).toMatchObject({
      resumed: true,
      handle: { sandboxId: handle.sandboxId, state: "running", podName: handle.sandboxName },
    });
    expect(mode(kube, handle.sandboxName)).toBe("Running");
    expect(podOf(kube, handle.sandboxName)?.spec).toMatchObject({ runtimeClassName: "gvisor" });
    // sandbox.woken is the caller's to record (it knows the trigger); the provider records none.
    expect(audits.filter((a) => a.action !== "sandbox.created")).toEqual([]);
  });

  it("calls isolation.require() before the resume patch", async () => {
    const order: string[] = [];
    const ctx = await hibernated();
    const require = vi.fn(async () => {
      order.push("require");
      return ctx.gate.require();
    });
    const provider = createSandboxProvider({
      kube: ctx.kube,
      isolation: { require },
      settings: SETTINGS,
      sleep: async () => {},
    });
    const patch = ctx.kube.patch.bind(ctx.kube);
    ctx.kube.patch = async (...args) => {
      order.push("patch");
      return patch(...args);
    };
    await provider.wakeSandbox(TEAM, USER);
    expect(order.slice(0, 2)).toEqual(["require", "patch"]);
  });

  it("creates nothing and leaves the sandbox hibernated when isolation is missing", async () => {
    const ctx = await hibernated();
    const provider = createSandboxProvider({
      kube: ctx.kube,
      isolation: {
        require: async () => {
          throw new IsolationRuntimeMissingError("no gVisor");
        },
      },
      settings: SETTINGS,
      sleep: async () => {},
    });
    await expect(provider.wakeSandbox(TEAM, USER)).rejects.toBeInstanceOf(
      IsolationRuntimeMissingError,
    );
    expect(mode(ctx.kube, ctx.handle.sandboxName)).toBe("Suspended");
    expect(ctx.kube.calls.filter((c) => c.verb === "patch")).toEqual([]);
  });

  it("re-applies the pod template from the current settings (image, Service IPs), dropping stale fields", async () => {
    const ctx = await hibernated();
    const name = ctx.handle.sandboxName;
    // The stored template predates an upgrade: an old image, an old ClusterIP and a stale field.
    ctx.kube.seed({
      ...sandboxOf(ctx.kube, name),
      spec: {
        ...(sandboxOf(ctx.kube, name).spec as object),
        podTemplate: {
          ...(sandboxOf(ctx.kube, name).spec as { podTemplate: object }).podTemplate,
          spec: { ...podSpec(ctx.kube, name), staleField: true },
        },
      },
    });
    ctx.kube.seed({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "kobe-server", namespace: "kobe" },
      spec: { clusterIP: "10.43.9.9" },
    });
    const upgraded = ctx.make({ ...SETTINGS, image: "ghcr.io/splittingatom/kobe-sandbox:0.2.0" });
    await upgraded.wakeSandbox(TEAM, USER);
    const spec = podSpec(ctx.kube, name) as {
      containers: { image: string }[];
      hostAliases: { ip: string; hostnames: string[] }[];
      staleField?: unknown;
    };
    expect(spec.containers[0]?.image).toBe("ghcr.io/splittingatom/kobe-sandbox:0.2.0");
    expect(spec.hostAliases).toContainEqual({
      ip: "10.43.9.9",
      hostnames: ["server.kobe.internal"],
    });
    expect(spec.staleField).toBeUndefined();
    expect(podOf(ctx.kube, name)?.spec).toMatchObject({
      containers: [{ image: "ghcr.io/splittingatom/kobe-sandbox:0.2.0" }],
    });
  });

  it("deletes the sandbox when its resumed pod is not under the verified runtime", async () => {
    let wakes = 0;
    const ctx = await hibernated({
      controller: { podRuntimeClass: (c) => (wakes > 0 ? "runc" : c) },
    });
    wakes += 1;
    await expect(ctx.provider.wakeSandbox(TEAM, USER)).rejects.toBeInstanceOf(
      IsolationRuntimeMissingError,
    );
    expect(ctx.kube.all("SandboxClaim")).toHaveLength(0);
    const destroyed = ctx.audits.find((a) => a.action === "sandbox.destroyed");
    expect(destroyed).toMatchObject({ target: { reason: "isolation_mismatch" } });
    expect(AUDIT_EVENTS["sandbox.destroyed"].target.parse(must(destroyed).target)).toBeTruthy();
  });

  it("waits for the old pod to finish terminating before returning the new one", async () => {
    const ctx = setup({ controller: { slowPodTermination: true } });
    const handle = await ctx.provider.ensureSandbox(TEAM, USER);
    await ctx.provider.hibernateSandbox(TEAM, USER, handle.sandboxId);
    const old = must(podOf(ctx.kube, handle.sandboxName));
    expect(old.metadata.deletionTimestamp).toBeDefined();
    const woken = await ctx.provider.wakeSandbox(TEAM, USER);
    const pod = must(podOf(ctx.kube, handle.sandboxName));
    expect(pod.metadata.deletionTimestamp).toBeUndefined();
    expect(pod.metadata.uid).not.toBe(old.metadata.uid);
    expect(woken.handle.state).toBe("running");
  });

  it("does nothing to a running sandbox", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    kube.calls.length = 0;
    await expect(provider.wakeSandbox(TEAM, USER)).resolves.toMatchObject({
      resumed: false,
      handle: { state: "running" },
    });
    expect(kube.calls.filter((c) => c.verb === "patch")).toEqual([]);
  });

  it("creates the first sandbox when there is none", async () => {
    const { kube, provider } = setup();
    await expect(provider.wakeSandbox(TEAM, USER)).resolves.toMatchObject({
      resumed: false,
      handle: { state: "running" },
    });
    expect(kube.all("SandboxClaim")).toHaveLength(1);
  });

  it("two replicas waking at once resume it once (optimistic concurrency)", async () => {
    const ctx = await hibernated();
    const other = ctx.make();
    const [a, b] = await Promise.all([
      ctx.provider.wakeSandbox(TEAM, USER),
      other.wakeSandbox(TEAM, USER),
    ]);
    expect(a.handle.podName).toBe(b.handle.podName);
    expect(mode(ctx.kube, ctx.handle.sandboxName)).toBe("Running");
    const patches = ctx.kube.calls.filter((c) => c.verb === "patch");
    expect(patches.length).toBeGreaterThanOrEqual(1);
    expect([a.resumed, b.resumed]).toContain(true);
  });

  it("a resume that loses the race to another writer re-reads and does not patch again", async () => {
    const ctx = await hibernated();
    const name = ctx.handle.sandboxName;
    const patch = ctx.kube.patch.bind(ctx.kube);
    let raced = false;
    const patched: string[] = [];
    ctx.kube.patch = async (ref, body, options) => {
      if (!raced) {
        raced = true;
        // Another replica resumes it between our read and our patch: ours carries a stale version.
        await ctx.make().wakeSandbox(TEAM, USER);
      }
      patched.push(options?.resourceVersion ?? "none");
      return patch(ref, body, options);
    };
    const woken = await ctx.provider.wakeSandbox(TEAM, USER);
    expect(woken.handle.state).toBe("running");
    expect(mode(ctx.kube, name)).toBe("Running");
    // The other replica's patch, then ours (refused with 409); after re-reading: Running, no patch.
    expect(patched).toHaveLength(2);
  });
});
