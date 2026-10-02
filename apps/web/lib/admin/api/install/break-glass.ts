/**
 * Install console: break-glass (spec D10; `/v1/install/break-glass`, install admins). Responses
 * arrive camelized; thread entry payloads stay verbatim (`payload` is opaque in lib/api/casing).
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export type GrantStatus = "pending" | "active" | "denied" | "revoked" | "expired";
export type GrantScope = "team" | "user" | "thread";

export interface GrantPerson {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface BreakGlassGrant {
  readonly id: string;
  readonly team: { readonly id: string; readonly slug: string; readonly name: string };
  readonly requestedBy: GrantPerson;
  readonly approvedBy: GrantPerson | null;
  readonly decidedBy: GrantPerson | null;
  readonly scope: GrantScope;
  readonly subject: GrantPerson | null;
  readonly threadId: string | null;
  readonly reason: string;
  readonly legalHold: boolean;
  readonly durationMinutes: number;
  readonly status: GrantStatus;
  readonly selfApproved: boolean;
  readonly requestedAt: string;
  readonly requestExpiresAt: string;
  readonly decidedAt: string | null;
  readonly startsAt: string | null;
  readonly expiresAt: string | null;
  readonly endedAt: string | null;
  /** What the server would allow the viewer now (courtesy: it decides again on each call). */
  readonly actions: {
    readonly approve: boolean;
    readonly deny: boolean;
    readonly revoke: boolean;
    readonly read: boolean;
  };
}

export interface GrantList {
  readonly grants: readonly BreakGlassGrant[];
  /** The viewer is the install's only active admin, so D10 lets them approve their own request. */
  readonly selfApprovalAllowed: boolean;
}

export interface GrantRequest {
  readonly teamId: string;
  readonly reason: string;
  readonly durationMinutes: number;
  readonly userId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly legalHold: boolean;
}

export function listGrants(): Promise<ApiResult<GrantList>> {
  return apiRequest<GrantList>("/v1/install/break-glass");
}

export function requestGrant(input: GrantRequest): Promise<ApiResult<GrantChange>> {
  return apiRequest<GrantChange>("/v1/install/break-glass", {
    method: "POST",
    json: {
      teamId: input.teamId,
      reason: input.reason,
      durationMinutes: input.durationMinutes,
      legalHold: input.legalHold,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
  });
}

export type GrantDecision = "approve" | "deny" | "revoke";

export interface GrantChange {
  readonly grant: BreakGlassGrant;
  /** Notifications queued (delivered with retry): everyone, and the team's admins among them. */
  readonly notified: { readonly recipients: number; readonly teamAdmins?: number };
  /** E.g. `no_team_admin_notified`: approved, but no active team admin could be told. */
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export function decideGrant(
  grantId: string,
  decision: GrantDecision,
): Promise<ApiResult<GrantChange>> {
  return apiRequest<GrantChange>(`/v1/install/break-glass/${enc(grantId)}/${decision}`, {
    method: "POST",
  });
}

// ── Reads under an active grant: every call is audited in the team's log ──

export interface ReadGrant {
  readonly id: string;
  readonly teamId: string;
  readonly scope: GrantScope;
  readonly userId: string | null;
  readonly threadId: string | null;
  readonly expiresAt: string;
}

export interface GrantThread {
  readonly threadId: string;
  readonly title: string | null;
  readonly status: string;
  readonly ownerUserId: string;
  readonly lastActivityAt: string;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

export interface GrantThreadPage {
  readonly grant: ReadGrant;
  readonly threads: readonly GrantThread[];
  readonly nextCursor: string | null;
}

export interface GrantEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly seq: number;
  readonly type: string;
  /** Pi's entry, verbatim. */
  readonly payload: Record<string, unknown>;
  readonly payloadOffloaded: boolean;
  readonly createdAt: string;
}

export interface GrantEntryPage {
  readonly grant: ReadGrant;
  readonly entries: readonly GrantEntry[];
  readonly nextAfter: number | null;
}

export function readGrantThreads(
  grantId: string,
  cursor?: string | null,
): Promise<ApiResult<GrantThreadPage>> {
  const query = cursor ? `?cursor=${enc(cursor)}` : "";
  return apiRequest<GrantThreadPage>(`/v1/install/break-glass/${enc(grantId)}/threads${query}`);
}

export function readGrantEntries(
  grantId: string,
  threadId: string,
  after = 0,
): Promise<ApiResult<GrantEntryPage>> {
  return apiRequest<GrantEntryPage>(
    `/v1/install/break-glass/${enc(grantId)}/threads/${enc(threadId)}/entries?after=${after}`,
  );
}
