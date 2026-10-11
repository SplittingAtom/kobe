/** Site console: invitations (`/v1/site`, site.users.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export interface SiteInvite {
  readonly id: string;
  readonly email: string;
  readonly invitedBy: { readonly id: string; readonly name: string };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "expired";
}

export interface InviteSent {
  readonly invitation: { readonly id: string; readonly email: string; readonly expiresAt: string };
  readonly emailSent: boolean;
}

export async function listSiteInvites(): Promise<ApiResult<readonly SiteInvite[]>> {
  const res = await apiRequest<{ invitations: SiteInvite[] }>("/v1/site/invites");
  return res.ok ? { ...res, data: res.data.invitations } : res;
}

export function createSiteInvite(email: string): Promise<ApiResult<InviteSent>> {
  return apiRequest("/v1/site/invites", { method: "POST", json: { email } });
}

export function resendSiteInvite(id: string): Promise<ApiResult<InviteSent>> {
  return apiRequest(`/v1/site/invites/${enc(id)}/resend`, { method: "POST" });
}

export function revokeSiteInvite(id: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/site/invites/${enc(id)}`, { method: "DELETE" });
}
