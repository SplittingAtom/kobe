import type { Logger } from "pino";
import {
  BifrostAdminError,
  type BifrostAdmin,
  type ObservedProvider,
  type ObservedVirtualKey,
} from "./bifrost-admin.js";
import type { DesiredProvider, DesiredState, DesiredVirtualKey } from "./desired.js";

/**
 * One reconcile pass (KOBE-40): makes Bifrost hold exactly {@link DesiredState}. Idempotent and
 * convergent: it observes Bifrost, changes only what differs, and keeps going past individual
 * failures (reported as error codes) so one bad entity doesn't block the rest.
 *
 * Order keeps references valid: providers and keys, customer, teams, virtual keys; then removals in
 * reverse (virtual keys, teams, customers, providers). A new key is added before the old one is
 * removed, so a key rotation never leaves a provider without a key.
 */
export interface ReconcileResult {
  /** Virtual key name → Bifrost id and value, for every desired key Bifrost now holds. */
  readonly virtualKeys: ReadonlyMap<string, { readonly id: string; readonly value: string }>;
  /** Writes made to Bifrost. */
  readonly changes: number;
  /** Machine-readable failures (empty when Bifrost now matches). */
  readonly errors: readonly string[];
}

const sameModels = (
  a: Readonly<Record<string, readonly string[]>>,
  b: Readonly<Record<string, readonly string[]>>,
) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return (
    ka.length === kb.length &&
    ka.every(
      (k, i) => k === kb[i] && (a[k] ?? []).join("\n") === [...(b[k] ?? [])].sort().join("\n"),
    )
  );
};

const providerDiffers = (want: DesiredProvider, have: ObservedProvider) =>
  (want.baseUrl ?? "") !== (have.baseUrl ?? "") ||
  want.allowPrivateNetwork !== have.allowPrivateNetwork ||
  want.custom !== have.custom ||
  (want.custom && want.keyless !== have.keyless);

const vkDiffers = (want: DesiredVirtualKey, teamId: string, have: ObservedVirtualKey) =>
  !have.isActive ||
  have.teamId !== teamId ||
  !have.allKeys ||
  !sameModels(want.models, have.models) ||
  want.limits !== undefined;

export async function reconcile(
  desired: DesiredState,
  admin: BifrostAdmin,
  logger: Logger,
): Promise<ReconcileResult> {
  const errors = new Set<string>();
  let changes = 0;
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      const code = err instanceof BifrostAdminError ? err.code : "sync_failed";
      errors.add(code);
      logger.warn({ err, what }, "model gateway sync step failed");
      return undefined;
    }
  };
  const write = async (what: string, fn: () => Promise<unknown>) => {
    const ok = await attempt(what, async () => {
      await fn();
      return true;
    });
    if (ok) changes++;
    return ok === true;
  };

  // ── providers and their keys ──
  const observedProviders = await attempt("list providers", () => admin.listProviders());
  if (!observedProviders) {
    return { virtualKeys: new Map(), changes, errors: [...errors] };
  }
  const haveProviders = new Map(observedProviders.map((p) => [p.name, p]));
  for (const want of desired.providers) {
    const have = haveProviders.get(want.name);
    if (!have) {
      if (!(await write(`add provider ${want.name}`, () => admin.addProvider(want)))) continue;
    } else if (providerDiffers(want, have)) {
      if (want.custom !== have.custom) {
        // A provider's base type can't change in place.
        await write(`replace provider ${want.name}`, async () => {
          await admin.deleteProvider(want.name);
          await admin.addProvider(want);
        });
      } else {
        await write(`update provider ${want.name}`, () => admin.updateProvider(want));
      }
    }
    const keys = (await attempt(`list keys ${want.name}`, () => admin.listKeys(want.name))) ?? [];
    const key = want.key;
    if (key && !keys.some((k) => k.name === key.name)) {
      await write(`add key ${want.name}`, () => admin.addKey(want.name, key));
    }
    for (const stale of keys.filter((k) => k.name !== key?.name)) {
      await write(`delete key ${want.name}`, () => admin.deleteKey(want.name, stale.id));
    }
  }

  // ── customer (the install) ──
  const customers = (await attempt("list customers", () => admin.listCustomers())) ?? [];
  let customer = customers.find((c) => c.name === desired.customer.name);
  if (!customer) {
    customer = await attempt("add customer", () =>
      admin.addCustomer(desired.customer.name, desired.customer.limits),
    );
    if (customer) changes++;
  }

  // ── teams ──
  const observedTeams = (await attempt("list teams", () => admin.listTeams())) ?? [];
  const teamIds = new Map<string, string>(); // Kobe team id → Bifrost team id
  const haveTeams = new Map(observedTeams.map((t) => [t.name, t]));
  for (const want of desired.teams) {
    const have = haveTeams.get(want.name);
    if (have) {
      teamIds.set(want.teamId, have.id);
      if (customer && have.customerId !== customer.id) {
        await write(`move team ${want.name}`, () => admin.updateTeam(have.id, customer.id));
      }
      continue;
    }
    if (!customer) continue;
    const created = await attempt(`add team ${want.name}`, () =>
      admin.addTeam(want.name, customer.id, want.limits),
    );
    if (created) {
      changes++;
      teamIds.set(want.teamId, created.id);
    }
  }

  // ── virtual keys (one per member per team) ──
  const virtualKeys = new Map<string, { id: string; value: string }>();
  const observedVks = await attempt("list virtual keys", () => admin.listVirtualKeys());
  if (observedVks) {
    const byName = new Map<string, ObservedVirtualKey>();
    const duplicates: ObservedVirtualKey[] = [];
    for (const vk of observedVks) {
      if (byName.has(vk.name)) duplicates.push(vk);
      else byName.set(vk.name, vk);
    }
    const wanted = new Set<string>();
    for (const want of desired.virtualKeys) {
      wanted.add(want.name);
      const teamId = teamIds.get(want.teamId);
      if (!teamId) continue;
      const spec = { name: want.name, teamId, models: want.models, limits: want.limits };
      const have = byName.get(want.name);
      if (!have) {
        const created = await attempt(`add vk ${want.name}`, () => admin.addVirtualKey(spec));
        if (created) {
          changes++;
          virtualKeys.set(want.name, created);
        }
        continue;
      }
      if (vkDiffers(want, teamId, have)) {
        await write(`update vk ${want.name}`, () => admin.updateVirtualKey(have.id, spec));
      }
      virtualKeys.set(want.name, { id: have.id, value: have.value });
    }
    for (const vk of [...duplicates, ...observedVks.filter((v) => !wanted.has(v.name))]) {
      await write(`delete vk ${vk.name}`, () => admin.deleteVirtualKey(vk.id));
    }
  }

  // ── removals: teams, customers, providers no longer desired ──
  if (observedVks) {
    const wantedTeams = new Set(desired.teams.map((t) => t.name));
    for (const team of observedTeams.filter((t) => !wantedTeams.has(t.name))) {
      await write(`delete team ${team.name}`, () => admin.deleteTeam(team.id));
    }
    for (const c of customers.filter((c) => c.id !== customer?.id)) {
      await write(`delete customer ${c.name}`, () => admin.deleteCustomer(c.id));
    }
    const wantedProviders = new Set(desired.providers.map((p) => p.name));
    for (const p of observedProviders.filter((p) => !wantedProviders.has(p.name))) {
      await write(`delete provider ${p.name}`, () => admin.deleteProvider(p.name));
    }
  }

  return { virtualKeys, changes, errors: [...errors] };
}
