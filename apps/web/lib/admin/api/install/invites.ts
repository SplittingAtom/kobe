/** Install console: invitations (`/v1/install`, install.users.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export interface InstallInvite {
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

export async function listInstallInvites(): Promise<ApiResult<readonly InstallInvite[]>> {
  const res = await apiRequest<{ invitations: InstallInvite[] }>("/v1/install/invites");
  return res.ok ? { ...res, data: res.data.invitations } : res;
}

export function createInstallInvite(email: string): Promise<ApiResult<InviteSent>> {
  return apiRequest("/v1/install/invites", { method: "POST", json: { email } });
}

export function resendInstallInvite(id: string): Promise<ApiResult<InviteSent>> {
  return apiRequest(`/v1/install/invites/${enc(id)}/resend`, { method: "POST" });
}

export function revokeInstallInvite(id: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/install/invites/${enc(id)}`, { method: "DELETE" });
}
