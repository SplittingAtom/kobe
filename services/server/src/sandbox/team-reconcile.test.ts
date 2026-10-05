import { describe, expect, it, vi } from "vitest";
import { createFakeKube } from "../testing/fake-kube.js";
import {
  OTHER_TEAM,
  SETTINGS,
  TEAM,
  gateFor,
  must,
  seedCluster,
} from "../testing/sandbox-fixtures.js";
import { EVAL_NETWORK_POLICY, NETWORK_POLICY } from "./constants.js";
import { createSandboxProvider } from "./provider.js";
import { createPgReconcileLock } from "./reconcile-lock.js";

const NS = "kobe-team-finance";
const policyRef = (name: string, namespace = NS) => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  name,
  namespace,
});

async function setup() {
  const kube = createFakeKube();
  seedCluster(kube);
  const gate = gateFor(kube);
  const provider = createSandboxProvider({ kube, isolation: gate, settings: SETTINGS });
  const verified = await gate.require();
  await provider.ensureTeam(TEAM, verified);
  await provider.ensureTeam(OTHER_TEAM, verified);
  return { kube, provider };
}

describe("reconcileTeams (KOBE-115)", () => {
  it("is idempotent: a converged install reports no policy change", async () => {
    const { provider } = await setup();
    const first = await provider.reconcileTeams();
    const second = await provider.reconcileTeams();
    expect(first).toMatchObject({ namespaces: 2, converged: 2, failed: 0, policyChanged: [] });
    expect(second).toMatchObject({ namespaces: 2, converged: 2, failed: 0, policyChanged: [] });
  });

  it("adds a missing rule: a deleted NetworkPolicy comes back and is flagged", async () => {
    const { kube, provider } = await setup();
    await kube.delete(policyRef(NETWORK_POLICY));
    expect(kube.peek(policyRef(NETWORK_POLICY))).toBeUndefined();
    const summary = await provider.reconcileTeams();
    expect(kube.peek(policyRef(NETWORK_POLICY))).toBeDefined();
    expect(summary.policyChanged).toEqual([NS]);
  });

  it("updates a changed rule to the current version", async () => {
    const { kube, provider } = await setup();
    const current = must(kube.peek(policyRef(EVAL_NETWORK_POLICY)));
    kube.seed({ ...current, spec: { podSelector: {}, policyTypes: ["Ingress"] } });
    const summary = await provider.reconcileTeams();
    expect(must(kube.peek(policyRef(EVAL_NETWORK_POLICY))).spec).toEqual(current.spec);
    expect(summary.policyChanged).toEqual([NS]);
  });

  it("leaves foreign objects alone and never deletes", async () => {
    const { kube, provider } = await setup();
    kube.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "customer-ns" } });
    kube.seed({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "someone-elses", namespace: NS },
      spec: { podSelector: {} },
    });
    kube.calls.length = 0;
    const summary = await provider.reconcileTeams();
    expect(summary.namespaces).toBe(2);
    expect(kube.peek(policyRef("someone-elses"))).toBeDefined();
    expect(kube.peek({ apiVersion: "v1", kind: "Namespace", name: "customer-ns" })).toBeDefined();
    expect(kube.calls.some((c) => c.verb === "delete")).toBe(false);
    expect(kube.calls.some((c) => c.namespace === "customer-ns")).toBe(false);
  });

  it("keeps going when one namespace fails and counts it", async () => {
    const { kube, provider } = await setup();
    kube.failNext("apply", "ResourceQuota", 500);
    const summary = await provider.reconcileTeams();
    expect(summary).toMatchObject({ namespaces: 2, converged: 1, failed: 1 });
  });

  it("skips namespaces being deleted", async () => {
    const { kube, provider } = await setup();
    const ns = must(kube.peek({ apiVersion: "v1", kind: "Namespace", name: NS }));
    kube.seed({ ...ns, metadata: { ...ns.metadata, deletionTimestamp: "2026-10-05T00:00:00Z" } });
    expect(await provider.reconcileTeams()).toMatchObject({ converged: 1, skipped: 1 });
  });

  it("does not run without verified isolation", async () => {
    const kube = createFakeKube();
    const provider = createSandboxProvider({
      kube,
      settings: SETTINGS,
      isolation: { require: () => Promise.reject(new Error("no isolation")) },
    });
    await expect(provider.reconcileTeams()).rejects.toThrow("no isolation");
  });
});

describe("pg reconcile lock", () => {
  const fakePool = (held: { value: boolean }) => {
    const queries: string[] = [];
    const client = {
      on: vi.fn(),
      off: vi.fn(),
      release: vi.fn(),
      query: vi.fn((sql: string) => {
        queries.push(sql);
        if (sql.includes("pg_try_advisory_lock")) {
          const ok = !held.value;
          held.value = true;
          return Promise.resolve({ rows: [{ ok }] });
        }
        held.value = false;
        return Promise.resolve({ rows: [] });
      }),
    };
    return { pool: { connect: () => Promise.resolve(client) }, client, queries };
  };

  it("a second replica does no work while the first holds the lock", async () => {
    const held = { value: false };
    const a = fakePool(held);
    const b = fakePool(held);
    const work = vi.fn(() => Promise.resolve("done"));
    let second:
      Awaited<ReturnType<ReturnType<typeof createPgReconcileLock>["runExclusive"]>> | undefined;
    const first = await createPgReconcileLock(a.pool as never).runExclusive(async () => {
      second = await createPgReconcileLock(b.pool as never).runExclusive(work);
      return "first";
    });
    expect(first).toEqual({ ran: true, value: "first" });
    expect(second).toEqual({ ran: false });
    expect(work).not.toHaveBeenCalled();
    expect(a.queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
    expect(held.value).toBe(false);
  });

  it("releases the lock when the work throws", async () => {
    const held = { value: false };
    const a = fakePool(held);
    await expect(
      createPgReconcileLock(a.pool as never).runExclusive(() => Promise.reject(new Error("x"))),
    ).rejects.toThrow("x");
    expect(held.value).toBe(false);
  });
});
