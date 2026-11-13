import type {
  HoldDecision,
  LegalHold,
  SiteLegalHold,
} from "../../../lib/admin/api/site/legal-hold";
import { Badge, type BadgeTone } from "../../ui/console";
import { DateTime } from "../parts";

/** Shared by the Workspace and Site-wide legal hold tables (KOBE-17, KOBE-647). */

export const STATUS_LABELS = {
  pending: "Waiting for approval",
  active: "In force",
  denied: "Denied",
  withdrawn: "Withdrawn",
  released: "Released",
} as const;

export const STATUS_TONES: Readonly<Record<LegalHold["status"], BadgeTone>> = {
  pending: "attention",
  active: "running",
  denied: "neutral",
  withdrawn: "neutral",
  released: "neutral",
};

export const DECISIONS: Record<
  HoldDecision,
  { readonly verb: string; readonly done: string; readonly tone: "primary" | "danger" }
> = {
  approve: {
    verb: "Place",
    done: "The hold is in force: purges of this data are suspended.",
    tone: "primary",
  },
  deny: { verb: "Deny", done: "Request denied.", tone: "danger" },
  withdraw: { verb: "Withdraw", done: "Request withdrawn.", tone: "danger" },
  "release/approve": {
    verb: "Release",
    done: "Released: purges of this data may resume.",
    tone: "danger",
  },
  "release/deny": {
    verb: "Deny the release of",
    done: "Release denied: the hold stays in force.",
    tone: "primary",
  },
  "release/withdraw": {
    verb: "Withdraw the release of",
    done: "Release request withdrawn: the hold stays in force.",
    tone: "primary",
  },
};

function approval(name: string, self: boolean, what: string): string {
  return self ? `${what} by ${name} alone (self-approved, flagged)` : `${what} by ${name}`;
}

export function HoldStatus({ hold }: { readonly hold: SiteLegalHold }) {
  return (
    <>
      <Badge tone={STATUS_TONES[hold.status]}>{STATUS_LABELS[hold.status]}</Badge>
      {hold.approvedBy && (
        <>
          <br />
          {approval(hold.approvedBy.name, hold.selfApproved, "Placed")}
        </>
      )}
      {hold.closedBy && (
        <>
          <br />
          {hold.status === "withdrawn" ? "Withdrawn" : "Denied"} by {hold.closedBy.name}
        </>
      )}
      {hold.release && (
        <>
          <br />
          <strong>Release requested</strong> by {hold.release.requestedBy?.name ?? "an admin"}:{" "}
          {hold.release.reason}
        </>
      )}
      {hold.releasedBy && (
        <>
          <br />
          {approval(hold.releasedBy.name, hold.releaseSelfApproved, "Released")}{" "}
          <DateTime value={hold.releasedAt} />
        </>
      )}
    </>
  );
}

export const BUTTONS: readonly [keyof LegalHold["actions"], HoldDecision | "release", string][] = [
  ["approve", "approve", "Place"],
  ["deny", "deny", "Deny"],
  ["withdraw", "withdraw", "Withdraw"],
  ["requestRelease", "release", "Ask to release"],
  ["approveRelease", "release/approve", "Approve release"],
  ["denyRelease", "release/deny", "Deny release"],
  ["withdrawRelease", "release/withdraw", "Withdraw release"],
];
