/**
 * Install console: legal hold (spec D18; `/v1/install/legal-hold`, install admins). Placing and
 * releasing a hold each need a second install admin (D10's rule). Responses arrive camelized.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export type HoldStatus = "pending" | "active" | "denied" | "withdrawn" | "released";
export type HoldScope = "team" | "user";

export interface HoldPerson {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface LegalHold {
  readonly id: string;
  readonly team: { readonly id: string; readonly slug: string; readonly name: string };
  readonly scope: HoldScope;
  readonly subject: HoldPerson | null;
  readonly reason: string;
  readonly status: HoldStatus;
  readonly requestedBy: HoldPerson;
  readonly requestedAt: string;
  readonly approvedBy: HoldPerson | null;
  readonly approvedAt: string | null;
  readonly selfApproved: boolean;
  readonly closedBy: HoldPerson | null;
  readonly closedAt: string | null;
  /** An open release request (the hold stays in force until a second admin approves it). */
  readonly release: {
    readonly requestedBy: HoldPerson | null;
    readonly requestedAt: string | null;
    readonly reason: string | null;
  } | null;
  readonly releasedBy: HoldPerson | null;
  readonly releasedAt: string | null;
  readonly releaseSelfApproved: boolean;
  /** What the server would allow the viewer now (courtesy: it decides again on each call). */
  readonly actions: {
    readonly approve: boolean;
    readonly deny: boolean;
    readonly withdraw: boolean;
    readonly requestRelease: boolean;
    readonly approveRelease: boolean;
    readonly denyRelease: boolean;
    readonly withdrawRelease: boolean;
  };
}

export interface HoldList {
  readonly holds: readonly LegalHold[];
  /** The viewer is the install's only active admin, so they may approve their own requests. */
  readonly selfApprovalAllowed: boolean;
}

export interface HoldRequest {
  readonly teamId: string;
  readonly userId?: string | undefined;
  readonly reason: string;
}

export type HoldDecision =
  "approve" | "deny" | "withdraw" | "release/approve" | "release/deny" | "release/withdraw";

type HoldResponse = { readonly hold: LegalHold };

export function listHolds(): Promise<ApiResult<HoldList>> {
  return apiRequest<HoldList>("/v1/install/legal-hold");
}

export function requestHold(input: HoldRequest): Promise<ApiResult<HoldResponse>> {
  return apiRequest<HoldResponse>("/v1/install/legal-hold", {
    method: "POST",
    json: {
      teamId: input.teamId,
      reason: input.reason,
      ...(input.userId ? { userId: input.userId } : {}),
    },
  });
}

export function decideHold(id: string, decision: HoldDecision): Promise<ApiResult<HoldResponse>> {
  return apiRequest<HoldResponse>(`/v1/install/legal-hold/${enc(id)}/${decision}`, {
    method: "POST",
  });
}

export function requestRelease(id: string, reason: string): Promise<ApiResult<HoldResponse>> {
  return apiRequest<HoldResponse>(`/v1/install/legal-hold/${enc(id)}/release`, {
    method: "POST",
    json: { reason },
  });
}
