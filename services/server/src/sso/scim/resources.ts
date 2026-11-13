import type { ScimUserRow } from "./users.js";
import {
  LIST_SCHEMA,
  RESOURCE_TYPE_SCHEMA,
  SCHEMA_SCHEMA,
  SCIM_MAX_RESULTS,
  SPC_SCHEMA,
  USER_SCHEMA,
} from "./schemas.js";

/** The SCIM base URL of a provider (§10): `<origin>/v1/scim/v2/<slug>`. */
export function scimBaseUrl(publicUrl: string, slug: string): string {
  return `${new URL(publicUrl).origin}/v1/scim/v2/${slug}`;
}

/** A Kobe user as a SCIM User resource (only what Kobe keeps). */
export function userResource(row: ScimUserRow, base: string) {
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    externalId: row.externalId,
    userName: row.userName,
    name: { formatted: row.name },
    displayName: row.name,
    active: row.deactivatedAt === null,
    emails: [{ value: row.email, type: "work", primary: true }],
    meta: {
      resourceType: "User",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: `${base}/Users/${row.id}`,
    },
  };
}

export function listResponse(
  resources: readonly unknown[],
  total: number,
  startIndex: number,
): Record<string, unknown> {
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** RFC 7643 §5, as §10 specifies: PATCH and filters yes; bulk, sort, ETags and password no. */
export function serviceProviderConfig(base: string) {
  return {
    schemas: [SPC_SCHEMA],
    documentationUri: "/docs",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "The SCIM token from the Kobe Site console (Single sign-on → SCIM).",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
  };
}

/** Users only: Groups come with SSO-8 (KOBE-632). */
export function userResourceType(base: string) {
  return {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: "User",
    name: "User",
    endpoint: "/Users",
    description: "Kobe user account",
    schema: USER_SCHEMA,
    schemaExtensions: [],
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` },
  };
}

const attribute = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

/** The core User schema, limited to the attributes Kobe keeps. */
export function userSchema(base: string) {
  return {
    schemas: [SCHEMA_SCHEMA],
    id: USER_SCHEMA,
    name: "User",
    description: "Kobe user account",
    attributes: [
      attribute("userName", { required: true, uniqueness: "server" }),
      attribute("externalId", { caseExact: true }),
      attribute("displayName"),
      attribute("name", {
        type: "complex",
        subAttributes: [attribute("formatted"), attribute("givenName"), attribute("familyName")],
      }),
      attribute("active", { type: "boolean" }),
      attribute("emails", {
        type: "complex",
        multiValued: true,
        subAttributes: [
          attribute("value"),
          attribute("type", { canonicalValues: ["work"] }),
          attribute("primary", { type: "boolean" }),
        ],
      }),
    ],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${USER_SCHEMA}` },
  };
}
