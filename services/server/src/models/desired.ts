import { createHmac } from "node:crypto";
import { gatewayProviderName, type ModelProviderKind } from "@kobe/db";
import type { GatewayLimits, KeySpec, ProviderSpec } from "./bifrost-admin.js";

/**
 * What Bifrost should hold, derived from Kobe's rows (KOBE-40, spec D30). Kobe is the source of
 * truth and owns the Bifrost instance: anything Bifrost has that is not desired is removed.
 *
 * - One Bifrost provider per Kobe provider, with one key whose name carries a fingerprint of the
 *   key material (so a changed key or Ollama URL is pushed; Bifrost redacts key values on read).
 * - Hierarchy (D30): customer = the install, Bifrost team = Kobe team, virtual key = a member in a
 *   team, allowed exactly the team's enabled catalog models (deny-by-default otherwise).
 */
export const INSTALL_CUSTOMER = "kobe-install";
export const gatewayTeamName = (teamId: string) => `kobe-team-${teamId}`;
export const virtualKeyName = (teamId: string, userId: string) => `kobe-vk-${teamId}-${userId}`;

export interface ProviderInput {
  readonly id: string;
  readonly kind: ModelProviderKind;
  readonly baseUrl: string | null;
  readonly allowPrivateNetwork: boolean;
  /** The opened API key; undefined when none is set (or it could not be opened). */
  readonly apiKey: string | undefined;
}

export interface CatalogInput {
  readonly alias: string;
  readonly providerId: string;
  readonly model: string;
}

export interface TeamInput {
  readonly teamId: string;
  /** Active members (not deactivated). */
  readonly members: readonly string[];
  /** Enabled catalog aliases. */
  readonly aliases: readonly string[];
}

/**
 * Budgets and rate limits per hierarchy level (KOBE-42 implements this; KOBE-40 sets none). The
 * sync passes them to Bifrost when it creates or updates the entity.
 */
export interface GovernanceLimitsSource {
  customer?(): GatewayLimits | undefined;
  team?(teamId: string): GatewayLimits | undefined;
  virtualKey?(teamId: string, userId: string): GatewayLimits | undefined;
}

export interface DesiredProvider extends ProviderSpec {
  readonly key: KeySpec | undefined;
}

export interface DesiredTeam {
  readonly teamId: string;
  readonly name: string;
  readonly limits: GatewayLimits | undefined;
}

export interface DesiredVirtualKey {
  readonly name: string;
  readonly teamId: string;
  readonly userId: string;
  /** Bifrost provider → allowed models, sorted; empty = no model allowed. */
  readonly models: Readonly<Record<string, readonly string[]>>;
  readonly limits: GatewayLimits | undefined;
}

export interface DesiredState {
  readonly providers: readonly DesiredProvider[];
  readonly customer: { readonly name: string; readonly limits: GatewayLimits | undefined };
  readonly teams: readonly DesiredTeam[];
  readonly virtualKeys: readonly DesiredVirtualKey[];
}

/** Key name `kobe-<provider>-<fingerprint>`: Bifrost requires names unique across providers. */
export function keyName(providerId: string, material: string, fingerprintSecret: string): string {
  const fp = createHmac("sha256", fingerprintSecret).update(material).digest("hex").slice(0, 16);
  return `kobe-${providerId}-${fp}`;
}

function desiredProvider(p: ProviderInput, fingerprintSecret: string): DesiredProvider {
  const name = gatewayProviderName(p.id, p.kind);
  const custom = p.kind === "openai_compatible";
  const baseUrl = p.baseUrl ?? undefined;
  let key: KeySpec | undefined;
  if (p.kind === "ollama") {
    // Bifrost's Ollama keys carry the server URL; the API key is optional (proxied Ollama).
    const value = p.apiKey ?? "";
    key = {
      name: keyName(p.id, `${value}\n${baseUrl ?? ""}`, fingerprintSecret),
      value,
      ...(baseUrl ? { ollamaUrl: baseUrl } : {}),
    };
  } else if (p.apiKey !== undefined) {
    key = { name: keyName(p.id, p.apiKey, fingerprintSecret), value: p.apiKey };
  }
  return {
    name,
    custom,
    keyless: custom && p.apiKey === undefined,
    baseUrl,
    allowPrivateNetwork: p.allowPrivateNetwork,
    key,
  };
}

export function buildDesiredState(
  input: {
    readonly providers: readonly ProviderInput[];
    readonly catalog: readonly CatalogInput[];
    readonly teams: readonly TeamInput[];
  },
  fingerprintSecret: string,
  limits: GovernanceLimitsSource = {},
): DesiredState {
  const providers = input.providers.map((p) => desiredProvider(p, fingerprintSecret));
  const providerNames = new Map(
    input.providers.map((p) => [p.id, gatewayProviderName(p.id, p.kind)]),
  );
  const catalog = new Map(input.catalog.map((c) => [c.alias, c]));
  const teams: DesiredTeam[] = [];
  const virtualKeys: DesiredVirtualKey[] = [];
  for (const team of input.teams) {
    teams.push({
      teamId: team.teamId,
      name: gatewayTeamName(team.teamId),
      limits: limits.team?.(team.teamId),
    });
    const models: Record<string, Set<string>> = {};
    for (const alias of team.aliases) {
      const entry = catalog.get(alias);
      const provider = entry && providerNames.get(entry.providerId);
      if (!entry || !provider) continue;
      (models[provider] ??= new Set()).add(entry.model);
    }
    const sorted = Object.fromEntries(
      Object.entries(models)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, set]) => [p, [...set].sort()]),
    );
    for (const userId of team.members) {
      virtualKeys.push({
        name: virtualKeyName(team.teamId, userId),
        teamId: team.teamId,
        userId,
        models: sorted,
        limits: limits.virtualKey?.(team.teamId, userId),
      });
    }
  }
  return {
    providers,
    customer: { name: INSTALL_CUSTOMER, limits: limits.customer?.() },
    teams,
    virtualKeys,
  };
}
