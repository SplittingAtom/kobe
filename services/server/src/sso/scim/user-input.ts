import {
  EMAIL_MAX,
  ENTERPRISE_USER_SCHEMA,
  SCIM_MAX_OPERATIONS,
  SCIM_STRING_MAX,
  USER_SCHEMA,
  type ScimType,
} from "./schemas.js";

/**
 * What a SCIM request asks to change on a User (KOBE-631, spec §10). Kobe keeps only these; every
 * other attribute (title, department, addresses, the enterprise extension, `roles` until SSO-8) is
 * accepted and ignored, so Entra's default attribute mappings don't fail provisioning.
 * `null` means "removed".
 */
export interface UserChanges {
  readonly userName?: string;
  readonly externalId?: string;
  readonly displayName?: string | null;
  readonly formatted?: string | null;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  /** The work (or primary) email. */
  readonly email?: string | null;
  readonly active?: boolean;
}

export type InputResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly scimType: ScimType; readonly detail: string };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Draft = Mutable<UserChanges>;

class InputError extends Error {
  constructor(
    readonly scimType: ScimType,
    readonly detail: string,
  ) {
    super(detail);
  }
}

const fail = (scimType: ScimType, detail: string): never => {
  throw new InputError(scimType, detail);
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown, attribute: string): string {
  if (typeof v !== "string") return fail("invalidValue", `${attribute} must be a string.`);
  const s = v.trim();
  if (s.length === 0) return fail("invalidValue", `${attribute} must not be empty.`);
  if (s.length > SCIM_STRING_MAX) return fail("invalidValue", `${attribute} is too long.`);
  return s;
}

/** An optional text attribute: null/empty clears it. */
function optionalText(v: unknown, attribute: string): string | null {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  return text(v, attribute);
}

/** Entra sends booleans as the strings "True" and "False" (any case). */
export function scimBoolean(v: unknown, attribute = "active"): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return fail("invalidValue", `${attribute} must be true or false.`);
}

/** Picks the work email (else the primary, else the first) from a SCIM `emails` value. */
function emailFromList(v: unknown): string | null {
  const list = Array.isArray(v) ? v : [v];
  const entries = list.filter(isObject);
  const pick =
    entries.find((e) => typeof e.type === "string" && e.type.toLowerCase() === "work") ??
    entries.find((e) => e.primary === true || e.primary === "True" || e.primary === "true") ??
    entries[0];
  return pick ? optionalEmail(pick.value) : null;
}

function optionalEmail(v: unknown): string | null {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v !== "string" || v.trim().length > EMAIL_MAX) {
    return fail("invalidValue", "emails value must be a string.");
  }
  return v.trim();
}

const CORE_PREFIX = `${USER_SCHEMA.toLowerCase()}:`;
const ENTERPRISE_PREFIX = ENTERPRISE_USER_SCHEMA.toLowerCase();
/** `emails[type eq "work"].value` and `emails[primary eq true].value` (quotes optional). */
const EMAIL_PATH = /^emails\[\s*(?:type\s+eq\s+"?work"?|primary\s+eq\s+"?true"?)\s*\]\.value$/i;

/**
 * Applies one attribute (a path, any case) to the draft. `remove` passes `undefined` as value.
 * Unknown attributes are ignored; the identity attributes can't be removed.
 */
function applyPath(draft: Draft, rawPath: string, value: unknown, remove: boolean): void {
  let path = rawPath.trim().toLowerCase();
  if (path.startsWith(CORE_PREFIX)) path = path.slice(CORE_PREFIX.length);
  if (path.startsWith(ENTERPRISE_PREFIX)) return;
  if (EMAIL_PATH.test(path)) {
    draft.email = remove ? null : optionalEmail(value);
    return;
  }
  switch (path) {
    case "username":
      if (remove) fail("mutability", "userName can't be removed.");
      draft.userName = text(value, "userName");
      return;
    case "externalid":
      if (remove) fail("mutability", "externalId can't be removed.");
      draft.externalId = text(value, "externalId");
      return;
    case "active":
      // Removing `active` changes nothing (a user is active unless told otherwise).
      if (!remove) draft.active = scimBoolean(value);
      return;
    case "displayname":
      draft.displayName = remove ? null : optionalText(value, "displayName");
      return;
    case "name.formatted":
      draft.formatted = remove ? null : optionalText(value, "name.formatted");
      return;
    case "name.givenname":
      draft.givenName = remove ? null : optionalText(value, "name.givenName");
      return;
    case "name.familyname":
      draft.familyName = remove ? null : optionalText(value, "name.familyName");
      return;
    case "name":
      if (remove) {
        draft.formatted = null;
        draft.givenName = null;
        draft.familyName = null;
      } else if (isObject(value)) {
        for (const [k, v] of Object.entries(value)) applyPath(draft, `name.${k}`, v, false);
      }
      return;
    case "emails":
      draft.email = remove ? null : emailFromList(value);
      return;
    default:
      return;
  }
}

function attempt<T>(fn: () => T): InputResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof InputError) return { ok: false, scimType: err.scimType, detail: err.detail };
    throw err;
  }
}

/**
 * Reads a PATCH body (RFC 7644 §3.5.2) the way Entra sends it: `op` in any case (`Replace`,
 * `Add`, `Remove`), operations without a `path` whose `value` is an object of attribute paths,
 * `active` as `"False"`, and `emails[type eq "work"].value` paths.
 */
export function parsePatch(body: unknown): InputResult<UserChanges> {
  return attempt(() => {
    if (!isObject(body)) return fail("invalidSyntax", "The body must be a PatchOp object.");
    const ops = body.Operations ?? body.operations;
    if (!Array.isArray(ops) || ops.length === 0) {
      return fail("invalidSyntax", "Operations must be a non-empty array.");
    }
    if (ops.length > SCIM_MAX_OPERATIONS) return fail("tooMany", "Too many operations.");
    const draft: Draft = {};
    for (const op of ops) {
      if (!isObject(op) || typeof op.op !== "string") {
        return fail("invalidSyntax", "Each operation needs an op.");
      }
      const kind = op.op.trim().toLowerCase();
      if (kind !== "add" && kind !== "replace" && kind !== "remove") {
        return fail("invalidSyntax", `Unknown op "${op.op}".`);
      }
      const path = typeof op.path === "string" && op.path.trim() !== "" ? op.path : undefined;
      if (kind === "remove") {
        if (path === undefined) return fail("noTarget", "A remove operation needs a path.");
        applyPath(draft, path, undefined, true);
      } else if (path !== undefined) {
        applyPath(draft, path, op.value, false);
      } else if (isObject(op.value)) {
        for (const [k, v] of Object.entries(op.value)) applyPath(draft, k, v, false);
      } else {
        return fail("invalidValue", "An operation without a path needs an object value.");
      }
    }
    return draft;
  });
}

/**
 * A full User resource (POST, PUT): `userName` required. Without `active`, a create makes an active
 * user and a replace leaves the activation as it is.
 */
export interface UserResourceInput extends UserChanges {
  readonly userName: string;
}

export function parseUserResource(body: unknown): InputResult<UserResourceInput> {
  return attempt(() => {
    if (!isObject(body)) return fail("invalidSyntax", "The body must be a User resource.");
    const draft: Draft = {};
    for (const [k, v] of Object.entries(body)) {
      // Read-only or message attributes: never applied.
      if (["schemas", "id", "meta", "groups"].includes(k.toLowerCase())) continue;
      applyPath(draft, k, v, false);
    }
    if (draft.userName === undefined) return fail("invalidValue", "userName is required.");
    return { ...draft, userName: draft.userName };
  });
}

const ADDRESS = /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/;

export function isAddress(v: string): boolean {
  return v.length <= EMAIL_MAX && ADDRESS.test(v);
}

/**
 * The Kobe sign-in address (§10): `userName` when it is an address (Entra's UPN), else the work
 * email; lowercased like every Kobe address. Undefined when neither is an address.
 */
export function addressFor(userName: string, email: string | null | undefined): string | undefined {
  if (isAddress(userName)) return userName.toLowerCase();
  if (email && isAddress(email)) return email.toLowerCase();
  return undefined;
}

/**
 * The display name: displayName, else name.formatted, else given + family names. A PATCH that
 * changes only one name part (`partial`) leaves the name as it is: Kobe keeps one name, not parts.
 */
export function nameFrom(c: UserChanges, partial = false): string | undefined {
  if (c.displayName) return c.displayName;
  if (c.formatted) return c.formatted;
  const parts = [c.givenName, c.familyName].filter((p): p is string => !!p);
  if (partial && parts.length < 2) return undefined;
  return parts.length > 0 ? parts.join(" ") : undefined;
}
