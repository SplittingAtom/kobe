/**
 * Semantic memory items over the shared API client (`/v1/memory/semantic/items`, KOBE-378;
 * contract KOBE-377 in `@kobe/protocol` semantic-memory/items.ts). Responses arrive camelized;
 * request bodies use the routes' snake_case. Every call sends `X-Kobe-Team` and keeps a refusal's
 * check results (`warnings`, `duplicates`, `policy_conflicts`, `current_version`, `capacity`) in
 * `error.details`, read with {@link checksOf}.
 */
import type { SemanticMemoryKind, SemanticMemoryScope, SemanticMemoryStatus } from "@kobe/protocol";
import { apiRequest, type ApiError, type ApiResult } from "../api/client";

export type ItemScope = SemanticMemoryScope;
export type ItemKind = SemanticMemoryKind;
export type ItemStatus = SemanticMemoryStatus;

export interface MemoryItem {
  readonly id: string;
  readonly scope: ItemScope;
  readonly kind: ItemKind;
  readonly status: ItemStatus;
  readonly statement: string;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly policy: boolean;
  readonly asOf: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface MemoryItemList {
  readonly scope: ItemScope;
  readonly items: readonly MemoryItem[];
  readonly nextCursor: string | null;
  readonly usage: { readonly count: number; readonly max: number };
}

/** Save over a warning: `lint` (instruction, personal data, links, near-duplicate), `policyConflict`. */
export interface Overrides {
  readonly lint?: true;
  readonly policyConflict?: true;
}

export interface NewItem {
  readonly scope: ItemScope;
  readonly kind: ItemKind;
  readonly statement: string;
  readonly tags: readonly string[];
}

export interface ItemChange {
  readonly expectedVersion: number;
  readonly statement?: string;
  readonly kind?: ItemKind;
  readonly tags?: readonly string[];
}

const enc = encodeURIComponent;
const BASE = "/v1/memory/semantic/items";

function overridesBody(o: Overrides | undefined): { overrides?: object } {
  if (o === undefined || (!o.lint && !o.policyConflict)) return {};
  return {
    overrides: {
      ...(o.lint ? { lint: true } : {}),
      ...(o.policyConflict ? { policy_conflict: true } : {}),
    },
  };
}

export interface MemoryItemsApi {
  list(scope: ItemScope, status: ItemStatus): Promise<ApiResult<MemoryItemList>>;
  /** A portable item needs `confirmPortable` (the person said yes to "Use in all my workspaces?"). */
  create(item: NewItem, overrides?: Overrides): Promise<ApiResult<MemoryItem>>;
  patch(
    item: MemoryItem,
    change: ItemChange,
    overrides?: Overrides,
  ): Promise<ApiResult<MemoryItem>>;
  archive(item: MemoryItem): Promise<ApiResult<MemoryItem>>;
  restore(item: MemoryItem, overrides?: Overrides): Promise<ApiResult<MemoryItem>>;
  /** Undo of an edit: a new version copying `version`. */
  revert(
    item: MemoryItem,
    version: number,
    expectedVersion: number,
    overrides?: Overrides,
  ): Promise<ApiResult<MemoryItem>>;
  pin(item: MemoryItem, pinned: boolean): Promise<ApiResult<MemoryItem>>;
}

export function createMemoryItemsApi(teamId: string, fetchFn?: typeof fetch): MemoryItemsApi {
  const at = (item: MemoryItem, action = "") =>
    `${BASE}/${enc(item.scope)}/${enc(item.id)}${action === "" ? "" : `/${action}`}`;
  const send = <T>(path: string, method: "GET" | "POST" | "PATCH", json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn, errorDetails: true });
  return {
    list: (scope, status) =>
      send(`${BASE}?scope=${enc(scope)}&status=${enc(status)}&limit=100`, "GET"),
    create: (item, overrides) =>
      send(BASE, "POST", {
        scope: item.scope,
        kind: item.kind,
        statement: item.statement,
        tags: item.tags,
        ...(item.scope === "portable" ? { confirm_portable: true } : {}),
        ...overridesBody(overrides),
      }),
    patch: (item, change, overrides) =>
      send(at(item), "PATCH", {
        expected_version: change.expectedVersion,
        ...(change.statement === undefined ? {} : { statement: change.statement }),
        ...(change.kind === undefined ? {} : { kind: change.kind }),
        ...(change.tags === undefined ? {} : { tags: change.tags }),
        ...overridesBody(overrides),
      }),
    archive: (item) => send(at(item, "archive"), "POST", { expected_version: item.version }),
    restore: (item, overrides) =>
      send(at(item, "restore"), "POST", {
        expected_version: item.version,
        ...overridesBody(overrides),
      }),
    revert: (item, version, expectedVersion, overrides) =>
      send(at(item, "revert"), "POST", {
        version,
        expected_version: expectedVersion,
        ...overridesBody(overrides),
      }),
    pin: (item, pinned) =>
      send(at(item, "pin"), "POST", { pinned, expected_version: item.version }),
  };
}

// ----------------------------------------------------------------------------- check results

export interface CheckIssue {
  readonly code: string;
  readonly message: string;
}

export interface Duplicate {
  readonly id: string;
  readonly similarity: number;
}

/** What a refused save says, for the editor to show inline. */
export interface CheckResults {
  readonly warnings: readonly CheckIssue[];
  readonly duplicates: readonly Duplicate[];
  readonly policyConflicts: readonly string[];
  readonly currentVersion: number | null;
  readonly capacity: { readonly count: number; readonly max: number } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The check results of a refusal; fields the body lacks (or holds malformed) are empty. */
export function checksOf(error: ApiError): CheckResults {
  const d = error.details ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : []);
  const cap = d["capacity"];
  return {
    warnings: list(d["warnings"])
      .filter((w) => str(w["code"]) && str(w["message"]))
      .map((w) => ({ code: w["code"] as string, message: w["message"] as string })),
    duplicates: list(d["duplicates"])
      .filter((x) => str(x["id"]))
      .map((x) => ({
        id: x["id"] as string,
        similarity: num(x["similarity"]) ? x["similarity"] : 0,
      })),
    policyConflicts: list(d["policyConflicts"])
      .map((x) => x["id"])
      .filter(str),
    currentVersion: num(d["currentVersion"]) ? d["currentVersion"] : null,
    capacity:
      isRecord(cap) && num(cap["count"]) && num(cap["max"])
        ? { count: cap["count"], max: cap["max"] }
        : null,
  };
}

/** Workspace wording for the item refusals; the server's own sentence otherwise. */
export function describeItemError(error: ApiError): string {
  switch (error.code) {
    case "memory_disabled":
      return "Memories are turned off for this workspace.";
    case "memory_secret":
      return "This looks like a password, key or token. Memories never hold secrets: remove it and save again.";
    case "memory_version_conflict":
      return "This memory changed since you opened it. Reload to see the latest version.";
    case "memory_scope_full": {
      const cap = checksOf(error).capacity;
      return cap
        ? `This place is full (${cap.count} of ${cap.max} memories). Archive one first.`
        : "This place is full. Archive a memory first.";
    }
    case "memory_pin_limit":
      return "You already have the most pinned memories here. Unpin one first.";
    case "memory_item_inactive":
      return "This memory is archived or was replaced. Restore it first.";
    case "memory_item_not_found":
      return "This memory no longer exists.";
    case "memory_not_allowed":
      return "You can read this memory but not change it.";
    default:
      return error.message;
  }
}
