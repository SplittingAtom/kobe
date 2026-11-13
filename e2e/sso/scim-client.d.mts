// Types for scim-client.mjs, so the browser suite (e2e/browser, strict TypeScript) can drive the
// same Entra-shaped SCIM client as the k3d gate (KOBE-634).

/** The fields of a SCIM body the callers read; null when the body was empty or not JSON. */
export type ScimJson = {
  readonly id?: string;
  readonly totalResults?: number;
  readonly Resources?: readonly { readonly id: string; readonly [k: string]: unknown }[];
  readonly detail?: string;
  readonly [k: string]: unknown;
} | null;

export interface ScimResponse {
  readonly status: number;
  readonly json: ScimJson;
  readonly contentType: string;
}

export interface ScimClient {
  request(method: string, path: string, body?: unknown): Promise<ScimResponse>;
  readonly log: string[];
}

export interface EntraUser {
  readonly externalId: string;
  readonly userName: string;
  readonly name?: string;
  readonly email?: string;
}

export const SCIM_USER: string;
export const SCIM_ENTERPRISE: string;
export const SCIM_PATCH: string;
export const SCIM_LIST: string;

export function scimClient(options: {
  readonly base: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: Record<string, string>;
}): ScimClient;

export function entraUserBody(u: EntraUser): Record<string, unknown>;

export const entra: {
  probe(scim: ScimClient): Promise<ScimResponse>;
  findByUserName(scim: ScimClient, userName: string): Promise<ScimResponse>;
  findByExternalId(scim: ScimClient, externalId: string): Promise<ScimResponse>;
  get(scim: ScimClient, id: string): Promise<ScimResponse>;
  create(scim: ScimClient, u: EntraUser): Promise<ScimResponse>;
  updateAttributes(
    scim: ScimClient,
    id: string,
    change: {
      readonly name?: string;
      readonly email?: string;
      readonly givenName?: string;
      readonly familyName?: string;
    },
  ): Promise<ScimResponse>;
  deactivate(scim: ScimClient, id: string): Promise<ScimResponse>;
  deactivatePathless(scim: ScimClient, id: string): Promise<ScimResponse>;
  reactivate(scim: ScimClient, id: string): Promise<ScimResponse>;
  remove(scim: ScimClient, id: string): Promise<ScimResponse>;
};

export function provisionUser(
  scim: ScimClient,
  u: EntraUser,
): Promise<{ readonly steps: string[]; readonly id: string | undefined }>;
