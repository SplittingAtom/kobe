import {
  Envelope,
  eq,
  teamWebSearch,
  webSearchSettings,
  withTeam,
  type KobeDb,
  type WebSearchProvider,
} from "@kobe/db";
import { z } from "zod";
import { recordAudit } from "../audit/record.js";
import { addCeilingDomain } from "../egress/ceiling-store.js";
import { providerInfo } from "./providers.js";

/** Visible ASCII only: the key becomes an HTTP header value. */
export const webSearchKeySchema = z
  .string()
  .min(8)
  .max(2048)
  .regex(/^[\x21-\x7e]+$/);

export const putWebSearchSchema = z.strictObject({
  provider: z.enum(["brave", "tavily", "exa"]),
  api_key: webSearchKeySchema.optional(),
  enabled: z.boolean().optional(),
});

/** An install-wide record has no team: the envelope binds to the nil team id. */
const INSTALL_TEAM = "00000000-0000-0000-0000-000000000000";
export const webSearchContext = {
  teamId: INSTALL_TEAM,
  kind: "web_search",
  recordId: "install",
} as const;

export interface WebSearchView {
  readonly configured: boolean;
  readonly provider?: WebSearchProvider;
  readonly enabled?: boolean;
  /** Masked: the last four characters of a long key. Never the key. */
  readonly hint?: string;
  readonly updatedAt?: string;
}

const maskHint = (key: string) => (key.length >= 16 ? `••••${key.slice(-4)}` : "••••");

const viewColumns = {
  provider: webSearchSettings.provider,
  enabled: webSearchSettings.enabled,
  hint: webSearchSettings.hint,
  updatedAt: webSearchSettings.updatedAt,
};

export async function readWebSearch(db: KobeDb): Promise<WebSearchView> {
  const [row] = await db.select(viewColumns).from(webSearchSettings);
  return row
    ? { configured: true, ...row, updatedAt: row.updatedAt.toISOString() }
    : { configured: false };
}

export type PutOutcome =
  | { readonly ok: true; readonly view: WebSearchView }
  | { readonly ok: false; readonly error: "key_required" };

export async function putWebSearch(
  db: KobeDb,
  envelope: Envelope,
  input: z.infer<typeof putWebSearchSchema>,
  userId: string,
): Promise<PutOutcome> {
  const sealedFields = input.api_key
    ? (() => {
        const sealed = envelope.seal(input.api_key, webSearchContext);
        return { sealed, keyId: Envelope.keyIdOf(sealed), hint: maskHint(input.api_key) };
      })()
    : undefined;
  const result = await db.transaction(async (tx): Promise<PutOutcome> => {
    const [existing] = await tx.select(viewColumns).from(webSearchSettings).for("update");
    const keep = existing !== undefined && existing.provider === input.provider;
    if (!sealedFields && !keep) return { ok: false, error: "key_required" };
    const enabled = input.enabled ?? existing?.enabled ?? true;
    const set = {
      provider: input.provider,
      enabled,
      ...(sealedFields ?? {}),
      updatedBy: userId,
      updatedAt: new Date(),
    };
    if (existing) {
      await tx.update(webSearchSettings).set(set);
    } else if (sealedFields) {
      await tx.insert(webSearchSettings).values({ ...set, ...sealedFields });
    }
    // A provider change leaves the old opt-ins in place: they follow the install's provider.
    await recordAudit(tx, {
      action: "websearch.install.configured",
      target: { provider: input.provider, enabled, keyChanged: sealedFields !== undefined },
    });
    const [view] = await tx.select(viewColumns).from(webSearchSettings);
    if (!view) throw new Error("web search settings vanished");
    return {
      ok: true,
      view: { configured: true, ...view, updatedAt: view.updatedAt.toISOString() },
    };
  });
  if (result.ok && result.view.enabled) {
    // Idempotent: a domain already in the ceiling is fine. The ceiling audits its own change.
    await addCeilingDomain(
      db,
      { domain: providerInfo(input.provider).domain, note: "Web search" },
      userId,
    );
  }
  return result;
}

/**
 * Removes the provider and its key; false when none was set. Team opt-ins stay but are dormant
 * (RLS keeps one team's rows from being touched in bulk); they apply again if a provider returns.
 */
export function removeWebSearch(db: KobeDb): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(webSearchSettings)
      .returning({ provider: webSearchSettings.provider });
    const provider = removed[0]?.provider;
    if (!provider) return false;
    await recordAudit(tx, { action: "websearch.install.removed", target: { provider } });
    return true;
  });
}

export interface TeamWebSearchView {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly provider: WebSearchProvider | null;
}

export async function readTeamWebSearch(db: KobeDb, teamId: string): Promise<TeamWebSearchView> {
  const install = await readWebSearch(db);
  const available = install.configured && install.enabled === true;
  const [row] = await withTeam(db, teamId, (tx) =>
    tx.select().from(teamWebSearch).where(eq(teamWebSearch.teamId, teamId)),
  );
  return {
    available,
    enabled: available && row !== undefined,
    provider: available ? (install.provider ?? null) : null,
  };
}

export type TeamOutcome =
  | { readonly ok: true; readonly view: TeamWebSearchView }
  | { readonly ok: false; readonly error: "unavailable" };

export async function setTeamWebSearch(
  db: KobeDb,
  teamId: string,
  enabled: boolean,
  userId: string,
): Promise<TeamOutcome> {
  if (enabled && !(await readTeamWebSearch(db, teamId)).available) {
    return { ok: false, error: "unavailable" };
  }
  await withTeam(db, teamId, async (tx) => {
    if (enabled) {
      await tx.insert(teamWebSearch).values({ teamId, enabledBy: userId }).onConflictDoNothing();
    } else {
      await tx.delete(teamWebSearch).where(eq(teamWebSearch.teamId, teamId));
    }
    await recordAudit(tx, { action: "websearch.team.changed", teamId, target: { enabled } });
  });
  return { ok: true, view: await readTeamWebSearch(db, teamId) };
}
