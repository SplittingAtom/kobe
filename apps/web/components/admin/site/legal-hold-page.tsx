"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  decideHold,
  listHolds,
  requestHold,
  requestRelease,
  type HoldDecision,
  type HoldList,
  type HoldScope,
  type LegalHold,
} from "../../../lib/admin/api/site/legal-hold";
import {
  listSiteTeams,
  teamRoster,
  type SiteTeam,
  type RosterMember,
} from "../../../lib/admin/api/site/teams";
import {
  Badge,
  Button,
  ChoiceGroup,
  EmptyState,
  Field,
  FormRow,
  PageHeader,
  Radio,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  eventTrigger,
  useConfirm,
  type BadgeTone,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";

interface PageData extends HoldList {
  readonly teams: readonly SiteTeam[];
}

async function loadPage(): Promise<ApiResult<PageData>> {
  const [holds, teams] = await Promise.all([listHolds(), listSiteTeams()]);
  if (!holds.ok) return holds;
  if (!teams.ok) return teams;
  return { ok: true, status: 200, data: { ...holds.data, teams: teams.data } };
}

const STATUS_LABELS = {
  pending: "Waiting for approval",
  active: "In force",
  denied: "Denied",
  withdrawn: "Withdrawn",
  released: "Released",
} as const;

const STATUS_TONES: Readonly<Record<LegalHold["status"], BadgeTone>> = {
  pending: "attention",
  active: "running",
  denied: "neutral",
  withdrawn: "neutral",
  released: "neutral",
};

const DECISIONS: Record<
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

export function holdScopeLabel(hold: Pick<LegalHold, "scope" | "subject">): string {
  return hold.scope === "user" ? `Data of ${hold.subject?.name ?? "one user"}` : "Whole team";
}

/**
 * Legal hold (spec D18; `/v1/site/legal-hold`). A site admin asks to hold a team's data, or
 * one user's data in a team, with a reason; a second site admin places it (a single-admin
 * site self-approves, flagged). While in force, retention and Trash purges, offboarding volume
 * deletion and the audit log's IP erasure skip that data. Releasing needs a second admin too.
 * Holds are confidential: the held user never sees them, and team admins aren't told.
 */
export function LegalHoldPage() {
  const { state, reload } = useResource(loadPage);
  const mutation = useMutation();
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  async function decide(
    hold: LegalHold,
    decision: HoldDecision,
    label: string,
    trigger: HTMLElement | null,
  ) {
    const { verb, done, tone } = DECISIONS[decision];
    const yes = await confirm(
      {
        title: `${verb} the legal hold on ${hold.team.name} (${holdScopeLabel(hold)})?`,
        confirmLabel: label,
        tone,
      },
      trigger,
    );
    if (!yes) return;
    if (
      await mutation.run(
        () => decideHold(hold.id, decision),
        () => done,
      )
    )
      reload();
  }

  return (
    <>
      <PageHeader
        title="Legal hold"
        description="A legal hold suspends every purge of a team's data, or of one user's data in a team: retention and Trash purges, deletion of an offboarded member's workspace, and the erasure of IP addresses from the audit log. Placing and releasing a hold each need a second site admin. The person held is not told, and can't see the hold."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="legal holds">
        {(data) => (
          <>
            <RequestForm
              teams={data.teams}
              soleAdmin={data.selfApprovalAllowed}
              mutation={mutation}
              onRequested={reload}
            />
            {releasing && (
              <ReleaseForm
                hold={releasing}
                mutation={mutation}
                onDone={() => {
                  setReleasing(null);
                  reload();
                }}
                onCancel={() => setReleasing(null)}
              />
            )}
            <Section title="Holds and requests">
              <HoldTable
                holds={data.holds}
                pending={mutation.pending}
                onDecide={(hold, decision, label, trigger) =>
                  void decide(hold, decision, label, trigger)
                }
                onRelease={setReleasing}
              />
            </Section>
          </>
        )}
      </ResourceView>
      {confirmDialog}
    </>
  );
}

function RequestForm({
  teams,
  soleAdmin,
  mutation,
  onRequested,
}: {
  readonly teams: readonly SiteTeam[];
  readonly soleAdmin: boolean;
  readonly mutation: Mutation;
  readonly onRequested: () => void;
}) {
  const [teamId, setTeamId] = useState("");
  const [scope, setScope] = useState<HoldScope>("team");
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [roster, setRoster] = useState<readonly RosterMember[]>([]);

  async function chooseTeam(id: string) {
    setTeamId(id);
    setUserId("");
    setRoster([]);
    if (!id) return;
    const res = await teamRoster(id);
    if (res.ok) setRoster(res.data);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () =>
        requestHold({
          teamId,
          reason: reason.trim(),
          userId: scope === "user" ? userId : undefined,
        }),
      ({ hold }) =>
        soleAdmin
          ? `Requested a hold on ${hold.team.name}. You are the only site admin: you can place it yourself (it will be flagged).`
          : `Requested a hold on ${hold.team.name}. A second site admin must place it.`,
    );
    if (done) {
      setReason("");
      setScope("team");
      setUserId("");
      onRequested();
    }
  }

  return (
    <Section title="Request a hold">
      <form onSubmit={onSubmit} aria-label="Request a legal hold">
        <FormRow className="mt-0">
          <Field label="Team">
            <Select required value={teamId} onChange={(e) => void chooseTeam(e.target.value)}>
              <option value="">Choose a team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <ChoiceGroup legend="Scope">
            {(["team", "user"] as const).map((s) => (
              <Radio
                key={s}
                name="scope"
                value={s}
                label={s === "team" ? "Whole team" : "One user's data in this team"}
                checked={scope === s}
                onChange={() => setScope(s)}
              />
            ))}
          </ChoiceGroup>
          {scope === "user" && (
            <Field label="User">
              <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose a member…</option>
                {roster.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name} ({m.email})
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </FormRow>
        <Field label="Reason" className="mb-3 max-w-2xl">
          <Textarea
            required
            minLength={10}
            maxLength={2000}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Request hold
        </Button>
      </form>
      {soleAdmin && (
        <p className="text-sm text-console-muted">
          You are this site&apos;s only active admin, so you can place and release holds you asked
          for yourself. They are flagged as self-approved.
        </p>
      )}
    </Section>
  );
}

function ReleaseForm({
  hold,
  mutation,
  onDone,
  onCancel,
}: {
  readonly hold: LegalHold;
  readonly mutation: Mutation;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => requestRelease(hold.id, reason.trim()),
      () => "Release requested. The hold stays in force until a second site admin approves.",
    );
    if (done) onDone();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Ask to release a legal hold" className="mt-6">
      <h2 className="m-0 mb-3 text-xl font-semibold">
        Release the hold on {hold.team.name} ({holdScopeLabel(hold)})
      </h2>
      <Field label="Why can it end?" className="mb-3 max-w-2xl">
        <Textarea
          required
          minLength={10}
          maxLength={2000}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Ask to release
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function approval(name: string, self: boolean, what: string): string {
  return self ? `${what} by ${name} alone (self-approved, flagged)` : `${what} by ${name}`;
}

function HoldStatus({ hold }: { readonly hold: LegalHold }) {
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

const BUTTONS: readonly [keyof LegalHold["actions"], HoldDecision | "release", string][] = [
  ["approve", "approve", "Place"],
  ["deny", "deny", "Deny"],
  ["withdraw", "withdraw", "Withdraw"],
  ["requestRelease", "release", "Ask to release"],
  ["approveRelease", "release/approve", "Approve release"],
  ["denyRelease", "release/deny", "Deny release"],
  ["withdrawRelease", "release/withdraw", "Withdraw release"],
];

function HoldTable({
  holds,
  pending,
  onDecide,
  onRelease,
}: {
  readonly holds: readonly LegalHold[];
  readonly pending: boolean;
  readonly onDecide: (
    hold: LegalHold,
    decision: HoldDecision,
    label: string,
    trigger: HTMLElement | null,
  ) => void;
  readonly onRelease: (hold: LegalHold) => void;
}) {
  if (holds.length === 0) return <EmptyState title="No legal holds yet." />;
  return (
    <Table caption="Holds and requests" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Team</TableHeader>
          <TableHeader>Scope</TableHeader>
          <TableHeader>Requested by</TableHeader>
          <TableHeader>Reason</TableHeader>
          <TableHeader>Status</TableHeader>
          <TableHeader>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {holds.map((hold) => (
          <TableRow key={hold.id}>
            <TableCell>{hold.team.name}</TableCell>
            <TableCell>{holdScopeLabel(hold)}</TableCell>
            <TableCell>
              {hold.requestedBy.name}
              <br />
              <span className="text-sm text-console-muted">
                <DateTime value={hold.requestedAt} />
              </span>
            </TableCell>
            <TableCell>{hold.reason}</TableCell>
            <TableCell>
              <HoldStatus hold={hold} />
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1.5">
                {BUTTONS.filter(([allowed]) => hold.actions[allowed]).map(
                  ([allowed, decision, label]) => (
                    <Button
                      key={allowed}
                      size="sm"
                      variant={
                        decision === "release" || DECISIONS[decision].tone === "primary"
                          ? "secondary"
                          : "danger"
                      }
                      disabled={pending}
                      onClick={(e) =>
                        decision === "release"
                          ? onRelease(hold)
                          : onDecide(hold, decision, label, eventTrigger(e))
                      }
                    >
                      {label}
                    </Button>
                  ),
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
