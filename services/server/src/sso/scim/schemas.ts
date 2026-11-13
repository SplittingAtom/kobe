/**
 * SCIM 2.0 constants (RFC 7643/7644) for Kobe's provisioning endpoint (KOBE-631, spec
 * sso-oidc-scim §10).
 */
export const SCIM_CONTENT_TYPE = "application/scim+json";
export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const ENTERPRISE_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SPC_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

/** Filter results per page (ServiceProviderConfig `filter.maxResults`). */
export const SCIM_MAX_RESULTS = 200;
/** Page size when the client names none. */
export const SCIM_DEFAULT_COUNT = 100;
/** Requests per minute one token may make (§10). */
export const SCIM_REQUESTS_PER_TOKEN_PER_MINUTE = 600;
/** Failed authentications per client address per minute before 429. */
export const SCIM_AUTH_FAILURES_PER_MINUTE = 30;
/** Largest request body accepted (a User resource is a few KiB). */
export const SCIM_MAX_BODY_BYTES = 64 * 1024;
/** At most this many PATCH operations in one request. */
export const SCIM_MAX_OPERATIONS = 100;
/** Bound on any single string Kobe reads from a SCIM request. */
export const SCIM_STRING_MAX = 256;
/** Bound on an email address. */
export const EMAIL_MAX = 320;

/** RFC 7644 §3.12 `scimType` values Kobe answers with. */
export type ScimType =
  | "invalidFilter"
  | "invalidValue"
  | "invalidPath"
  | "invalidSyntax"
  | "noTarget"
  | "uniqueness"
  | "mutability"
  | "tooMany";
