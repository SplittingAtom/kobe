import { SCIM_DEFAULT_COUNT, SCIM_MAX_RESULTS, SCIM_STRING_MAX, USER_SCHEMA } from "./schemas.js";

/** The one filter shape Kobe serves (what Entra sends): `<attribute> eq "<value>"`. */
export interface UserFilter {
  readonly attribute: "userName" | "externalId" | "id";
  readonly value: string;
}

export type FilterResult =
  | { readonly ok: true; readonly filter: UserFilter | null }
  | { readonly ok: false; readonly detail: string };

const ATTRIBUTES: Record<string, UserFilter["attribute"]> = {
  username: "userName",
  externalid: "externalId",
  id: "id",
};

const EQ = /^\s*([A-Za-z0-9:._-]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

/**
 * Parses a `filter` query parameter. Only `userName`, `externalId` and `id` with `eq` and a string
 * value are served (attribute names and `eq` in any case, the core schema URN prefix allowed);
 * anything else is `invalidFilter`, never silently widened into a full listing.
 */
export function parseUserFilter(raw: string | undefined): FilterResult {
  if (raw === undefined || raw.trim() === "") return { ok: true, filter: null };
  if (raw.length > SCIM_STRING_MAX * 2) return { ok: false, detail: "The filter is too long." };
  const m = EQ.exec(raw);
  if (!m) {
    return {
      ok: false,
      detail:
        'Kobe supports only filters of the form userName eq "…", externalId eq "…" or id eq "…".',
    };
  }
  const name = (m[1] ?? "").toLowerCase();
  const prefix = `${USER_SCHEMA.toLowerCase()}:`;
  const attribute = ATTRIBUTES[name.startsWith(prefix) ? name.slice(prefix.length) : name];
  if (!attribute) {
    return { ok: false, detail: `Kobe can't filter Users on "${m[1] ?? ""}".` };
  }
  const value = (m[2] ?? "").replace(/\\(.)/g, "$1");
  if (value.length > SCIM_STRING_MAX) return { ok: false, detail: "The filter value is too long." };
  return { ok: true, filter: { attribute, value } };
}

export interface Paging {
  /** 1-based (RFC 7644 §3.4.2.4); values below 1 count as 1. */
  readonly startIndex: number;
  /** 0 answers only `totalResults`; capped at `SCIM_MAX_RESULTS`. */
  readonly count: number;
}

function intOf(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^-?\d{1,9}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/** `startIndex` and `count` as RFC 7644 says to read them (lenient, never an error). */
export function parsePaging(startIndex: string | undefined, count: string | undefined): Paging {
  const start = intOf(startIndex);
  const n = intOf(count);
  return {
    startIndex: start === undefined || start < 1 ? 1 : start,
    count: n === undefined ? SCIM_DEFAULT_COUNT : Math.min(Math.max(n, 0), SCIM_MAX_RESULTS),
  };
}
