/**
 * Install console resources (`/v1/install/*`). Wire casing per route lives here; responses arrive
 * camelized (lib/api/casing.ts). The server enforces every permission named in the comments.
 */
import { apiRequest, type ApiResult } from "../../api/client";
import type { InstallRole } from "../nav/types";

const enc = encodeURIComponent;

// ---- users (install.users.manage) ----

export interface InstallUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly installRole: InstallRole;
  readonly twoFactorEnabled: boolean;
  readonly deactivatedAt: string | null;
  readonly createdAt: string;
}

export interface DeactivationResult {
  readonly userId: string;
  readonly deactivated: boolean;
  /** Teams whose only active team admin this was (deactivation only). */
  readonly teamsWithoutActiveAdmin?: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  }[];
  /** Downstream steps (sandboxes, grants, schedules…) that failed; deactivation still holds. */
  readonly incompleteSteps: readonly string[];
}

export async function listUsers(): Promise<ApiResult<readonly InstallUser[]>> {
  const res = await apiRequest<{ users: InstallUser[] }>("/v1/install/users");
  return res.ok ? { ...res, data: res.data.users } : res;
}

export function setUserActive(
  userId: string,
  active: boolean,
): Promise<ApiResult<DeactivationResult>> {
  return apiRequest(`/v1/install/users/${enc(userId)}/${active ? "reactivate" : "deactivate"}`, {
    method: "POST",
  });
}

// ---- invitations (install.users.manage) ----

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

// ---- install roles (read: install.users.manage; change: Owner only) ----

export interface InstallRoleHolder {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: "owner" | "admin";
}

export async function listInstallRoles(): Promise<ApiResult<readonly InstallRoleHolder[]>> {
  const res = await apiRequest<{ roles: InstallRoleHolder[] }>("/v1/install/roles");
  return res.ok ? { ...res, data: res.data.roles } : res;
}

export function setInstallRole(
  userId: string,
  role: "admin" | "user",
): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/install/roles/${enc(userId)}`, { method: "PUT", json: { role } });
}

export function transferOwnership(userId: string): Promise<ApiResult<unknown>> {
  return apiRequest("/v1/install/roles/transfer-ownership", { method: "POST", json: { userId } });
}

// ---- teams (install.teams.manage) ----

export interface InstallTeam {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt?: string;
}

export interface RosterMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: "team_admin" | "builder" | "member";
  readonly joinedAt: string;
}

/** Mirrors the server's team slug rule (it names the `kobe-team-<slug>` namespace). */
export const TEAM_SLUG_PATTERN = "[a-z0-9]([a-z0-9\\-]{0,30}[a-z0-9])?";

export async function listInstallTeams(): Promise<ApiResult<readonly InstallTeam[]>> {
  const res = await apiRequest<{ teams: InstallTeam[] }>("/v1/install/teams");
  return res.ok ? { ...res, data: res.data.teams } : res;
}

export async function createTeam(input: {
  slug: string;
  name: string;
  adminUserId: string;
}): Promise<ApiResult<InstallTeam>> {
  const res = await apiRequest<{ team: InstallTeam }>("/v1/install/teams", {
    method: "POST",
    json: { slug: input.slug, name: input.name, adminUserId: input.adminUserId },
  });
  return res.ok ? { ...res, data: res.data.team } : res;
}

export async function renameTeam(teamId: string, name: string): Promise<ApiResult<InstallTeam>> {
  const res = await apiRequest<{ team: InstallTeam }>(`/v1/install/teams/${enc(teamId)}`, {
    method: "PATCH",
    json: { name },
  });
  return res.ok ? { ...res, data: res.data.team } : res;
}

export async function teamRoster(teamId: string): Promise<ApiResult<readonly RosterMember[]>> {
  const res = await apiRequest<{ members: RosterMember[] }>(
    `/v1/install/teams/${enc(teamId)}/members`,
  );
  return res.ok ? { ...res, data: res.data.members } : res;
}

// ---- settings (install.settings.manage; turning 2FA off: Owner only) ----

export interface InstallSettings {
  readonly requireTwoFactor: boolean;
}

export function getInstallSettings(): Promise<ApiResult<InstallSettings>> {
  return apiRequest("/v1/install/settings");
}

export function putInstallSettings(settings: InstallSettings): Promise<ApiResult<InstallSettings>> {
  return apiRequest("/v1/install/settings", {
    method: "PUT",
    json: { requireTwoFactor: settings.requireTwoFactor },
  });
}

// ---- isolation (install.settings.manage) ----

export type IsolationStatus =
  | {
      readonly state: "checking";
      readonly agentsEnabled: false;
      readonly runtimeClassName?: string;
    }
  | {
      readonly state: "verified";
      readonly agentsEnabled: true;
      readonly runtimeClassName: string;
      readonly handler: string;
      readonly checkedAt: string;
    }
  | {
      readonly state: "missing";
      readonly agentsEnabled: false;
      readonly runtimeClassName?: string;
      readonly message: string;
      readonly checkedAt: string;
      readonly docs: string;
    };

export function getIsolation(): Promise<ApiResult<IsolationStatus>> {
  return apiRequest("/v1/install/isolation");
}

export function recheckIsolation(): Promise<ApiResult<IsolationStatus>> {
  return apiRequest("/v1/install/isolation/check", { method: "POST" });
}

// ---- gallery agents (install.gallery.manage) ----

export interface AgentSummary {
  readonly id: string;
  readonly scope: "team" | "personal" | "gallery";
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly status: "active" | "suspended";
  readonly ownerUserId: string | null;
  readonly currentVersion: number | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly canEdit: boolean;
}

export interface AgentSaved {
  readonly agent: AgentSummary;
  readonly warnings?: readonly unknown[];
}

export const GALLERY_PATH = "/v1/install/gallery/agents";

export async function listGalleryAgents(): Promise<ApiResult<readonly AgentSummary[]>> {
  const res = await apiRequest<{ agents: AgentSummary[] }>(GALLERY_PATH);
  return res.ok ? { ...res, data: res.data.agents } : res;
}

export function setGalleryAgentStatus(
  id: string,
  status: AgentSummary["status"],
): Promise<ApiResult<AgentSaved>> {
  return apiRequest(`${GALLERY_PATH}/${enc(id)}/status`, { method: "PUT", json: { status } });
}

export function deleteGalleryAgent(id: string): Promise<ApiResult<void>> {
  return apiRequest(`${GALLERY_PATH}/${enc(id)}`, { method: "DELETE" });
}

/** Imports an agent markdown file (§6.3) into the gallery. */
export function importGalleryAgent(file: string): Promise<ApiResult<AgentSaved>> {
  return apiRequest(GALLERY_PATH, {
    method: "POST",
    raw: { body: file, contentType: "text/markdown; charset=utf-8" },
  });
}

export function galleryExportHref(id: string): string {
  return `${GALLERY_PATH}/${enc(id)}/export`;
}
