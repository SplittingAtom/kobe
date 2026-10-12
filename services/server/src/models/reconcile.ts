import type { Logger } from "pino";
import {
  BifrostAdminError,
  vkActive,
  type BifrostAdmin,
  type ObservedCustomer,
  type ObservedProvider,
  type ObservedTeam,
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

/** The desired per-minute request limit of a virtual key (KOBE-42), if any. */
const wantedPerMinute = (want: DesiredVirtualKey): number | undefined => {
  const max = want.limits?.rate_limit?.request_max_limit;
  return typeof max === "number" ? max : undefined;
};

const vkDiffers = (want: DesiredVirtualKey, teamId: string, have: ObservedVirtualKey) =>
  have.isActive !== vkActive(want) ||
  have.teamId !== teamId ||
  !have.allKeys ||
  !sameModels(want.models, have.models) ||
  (wantedPerMinute(want) !== undefined && wantedPerMinute(want) !== have.requestsPerMinute) ||
  (want.limits?.budgets !== undefined && want.limits.budgets.length > 0);

/** Customer names Kobe used before: `kobe-install` until KOBE-256 renamed it to the site's. */
export const LEGACY_CUSTOMERS: readonly string[] = ["kobe-install"];

interface SiteCustomer {
  readonly customer: ObservedCustomer | undefined;
  /** No site customer yet: the caller adds it. */
  readonly create: boolean;
  /** A customer deleted here (an empty stray holding the site's name). */
  readonly deleted?: string;
}

/**
 * Picks the site customer (KOBE-265). Bifrost cannot move a team to another customer (see
 * `updateTeam`), so a legacy customer is renamed in place: its teams and their virtual keys stay
 * as they are. An empty customer already holding the site's name (left by KOBE-256's
 * create-and-move) is deleted first, as names are unique.
 */
async function siteCustomer(
  want: DesiredState["customer"],
  customers: readonly ObservedCustomer[],
  teams: readonly ObservedTeam[],
  admin: BifrostAdmin,
  write: (what: string, fn: () => Promise<unknown>) => Promise<boolean>,
): Promise<SiteCustomer> {
  const site = customers.find((c) => c.name === want.name);
  const legacy = customers.find((c) => LEGACY_CUSTOMERS.includes(c.name));
  const owns = (c: ObservedCustomer) => teams.some((t) => t.customerId === c.id);
  if (!legacy) return { customer: site, create: !site };
  if (site && (owns(site) || !owns(legacy))) return { customer: site, create: false };
  if (site && !(await write(`delete customer ${site.name}`, () => admin.deleteCustomer(site.id)))) {
    return { customer: legacy, create: false };
  }
  const renamed = await write(`rename customer ${legacy.name}`, () =>
    admin.updateCustomer(legacy.id, want.name, want.limits),
  );
  return {
    customer: renamed ? { ...legacy, name: want.name } : legacy,
    create: false,
    ...(site ? { deleted: site.id } : {}),
  };
}

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

  // ── customer (the site) and teams ──
  const customers = await attempt("list customers", () => admin.listCustomers());
  const observedTeams = await attempt("list teams", () => admin.listTeams());
  // Without both listings nothing is created, renamed or deleted (and no team is added).
  const site: SiteCustomer =
    customers && observedTeams
      ? await siteCustomer(desired.customer, customers, observedTeams, admin, write)
      : { customer: undefined, create: false };
  let customer = site.customer;
  if (site.create) {
    customer = await attempt("add customer", () =>
      admin.addCustomer(desired.customer.name, desired.customer.limits),
    );
    if (customer) changes++;
  }

  const teamIds = new Map<string, string>(); // Kobe team id → Bifrost team id
  const haveTeams = new Map((observedTeams ?? []).map((t) => [t.name, t]));
  for (const want of desired.teams) {
    const have = haveTeams.get(want.name);
    if (have) {
      teamIds.set(want.teamId, have.id);
      if (customer && have.customerId === undefined) {
        await write(`attach team ${want.name}`, () => admin.updateTeam(have.id, customer.id));
      } else if (customer && have.customerId !== customer.id) {
        // Bifrost cannot move a team between customers (see `updateTeam`); it keeps working.
        logger.warn({ team: want.name }, "model gateway team belongs to another Bifrost customer");
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
    for (const team of (observedTeams ?? []).filter((t) => !wantedTeams.has(t.name))) {
      await write(`delete team ${team.name}`, () => admin.deleteTeam(team.id));
    }
    // Another customer (an empty stray, or one whose teams were all removed) goes only once the
    // site customer exists and no team points at it any more: teams are listed again, so a failed
    // team removal keeps its customer until a later pass succeeds (Bifrost would detach them).
    const remaining = customer ? await attempt("list teams", () => admin.listTeams()) : undefined;
    if (customer && remaining) {
      const owners = new Set(remaining.map((t) => t.customerId));
      const others = (customers ?? []).filter((c) => c.id !== customer.id && c.id !== site.deleted);
      for (const c of others.filter((c) => !owners.has(c.id))) {
        await write(`delete customer ${c.name}`, () => admin.deleteCustomer(c.id));
      }
    }
    const wantedProviders = new Set(desired.providers.map((p) => p.name));
    for (const p of observedProviders.filter((p) => !wantedProviders.has(p.name))) {
      await write(`delete provider ${p.name}`, () => admin.deleteProvider(p.name));
    }
  }

  return { virtualKeys, changes, errors: [...errors] };
}
