/**
 * Single sign-on account links (KOBE-630, spec sso-oidc-scim §6). Site console:
 * `/v1/site/sso/users/:id/...` (site.users.manage); Me → Sign-in methods: `/v1/me/sso/links`.
 * Responses arrive camelized. Every route answers 404 while single sign-on is off.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export interface SsoLink {
  readonly providerId: string;
  readonly providerName: string;
  readonly linkedVia: "jit" | "local_proof" | "admin_expected" | "scim";
  readonly emailAtLink: string | null;
  readonly linkedAt: string;
  readonly lastSignInAt: string | null;
}

export interface SsoLinkExpectation {
  readonly providerId: string;
  readonly providerName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface UserSsoLinks {
  readonly links: readonly SsoLink[];
  readonly expectations: readonly SsoLinkExpectation[];
}

export interface Unlinked {
  readonly unlinked: true;
  readonly sessionsEnded: number;
}

const userBase = (userId: string) => `/v1/site/sso/users/${enc(userId)}`;

export function getUserSsoLinks(userId: string): Promise<ApiResult<UserSsoLinks>> {
  return apiRequest(`${userBase(userId)}/links`);
}

export async function expectSsoLink(
  userId: string,
  providerId: string,
): Promise<ApiResult<SsoLinkExpectation>> {
  const res = await apiRequest<{ expectation: SsoLinkExpectation }>(
    `${userBase(userId)}/link-expectations/${enc(providerId)}`,
    { method: "PUT" },
  );
  return res.ok ? { ...res, data: res.data.expectation } : res;
}

export function withdrawSsoLinkExpectation(
  userId: string,
  providerId: string,
): Promise<ApiResult<{ withdrawn: true }>> {
  return apiRequest(`${userBase(userId)}/link-expectations/${enc(providerId)}`, {
    method: "DELETE",
  });
}

export function unlinkUserSso(userId: string, providerId: string): Promise<ApiResult<Unlinked>> {
  return apiRequest(`${userBase(userId)}/links/${enc(providerId)}`, { method: "DELETE" });
}

export async function listMySsoLinks(): Promise<ApiResult<readonly SsoLink[]>> {
  const res = await apiRequest<{ links: SsoLink[] }>("/v1/me/sso/links");
  return res.ok ? { ...res, data: res.data.links } : res;
}

export function unlinkMySso(providerId: string): Promise<ApiResult<Unlinked>> {
  return apiRequest(`/v1/me/sso/links/${enc(providerId)}`, { method: "DELETE" });
}

/** How a link was made, in words. */
export const LINKED_VIA_LABEL: Readonly<Record<SsoLink["linkedVia"], string>> = {
  jit: "Created at first sign-in",
  local_proof: "Linked by you",
  admin_expected: "Linked by an admin",
  scim: "Provisioned",
};

/** A local proof waiting for the signed-in user's confirmation (review M1). */
export interface PendingSsoLink {
  readonly providerId: string;
  readonly providerName: string;
  readonly email: string;
}

export async function getPendingSsoLink(): Promise<ApiResult<PendingSsoLink | null>> {
  const res = await apiRequest<{ pending: PendingSsoLink | null }>("/v1/me/sso/pending-link");
  return res.ok ? { ...res, data: res.data.pending } : res;
}

export function confirmPendingSsoLink(): Promise<ApiResult<{ linked: true }>> {
  return apiRequest("/v1/me/sso/pending-link/confirm", { method: "POST" });
}

export function discardPendingSsoLink(): Promise<ApiResult<{ discarded: true }>> {
  return apiRequest("/v1/me/sso/pending-link", { method: "DELETE" });
}
