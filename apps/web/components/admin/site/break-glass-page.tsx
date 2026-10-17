"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  decideGrant,
  listGrants,
  requestGrant,
  type BreakGlassGrant,
  type GrantDecision,
  type GrantList,
  type GrantScope,
} from "../../../lib/admin/api/site/break-glass";
import {
  listSiteTeams,
  teamRoster,
  type SiteTeam,
  type RosterMember,
} from "../../../lib/admin/api/site/teams";
import {
  Badge,
  Button,
  Checkbox,
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
  TextInput,
  Textarea,
  eventTrigger,
  useConfirm,
  type BadgeTone,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { BreakGlassReader } from "./break-glass-reader";

interface PageData extends GrantList {
  readonly teams: readonly SiteTeam[];
}

async function loadPage(): Promise<ApiResult<PageData>> {
  const [grants, teams] = await Promise.all([listGrants(), listSiteTeams()]);
  if (!grants.ok) return grants;
  if (!teams.ok) return teams;
  return { ok: true, status: 200, data: { ...grants.data, teams: teams.data } };
}

const DURATIONS = [15, 30, 60, 120, 240, 480, 1440] as const;

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

const STATUS_LABELS = {
  pending: "Waiting for approval",
  active: "Active",
  denied: "Denied",
  revoked: "Revoked",
  expired: "Ended",
} as const;

const STATUS_TONES: Readonly<Record<BreakGlassGrant["status"], BadgeTone>> = {
  pending: "attention",
  active: "running",
  denied: "neutral",
  revoked: "neutral",
  expired: "neutral",
};

export function scopeLabel(grant: Pick<BreakGlassGrant, "scope" | "subject" | "threadId">): string {
  if (grant.scope === "user") return `Threads of ${grant.subject?.name ?? "one user"}`;
  if (grant.scope === "thread") return `Thread ${grant.threadId ?? ""}`;
  return "Whole team";
}

/**
 * Break-glass (spec D10; `/v1/site/break-glass`). A site admin asks for time-boxed,
 * read-only access to one team (optionally one user or one thread) with a reason; a second site
 * admin approves (a single-admin site self-approves, flagged). The team's admins are notified,
 * and every read is recorded in the team's audit log. The server and the database decide.
 */
export function BreakGlassPage() {
  const { state, reload } = useResource(loadPage);
  const mutation = useMutation();
  const [reading, setReading] = useState<BreakGlassGrant | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  async function decide(
    grant: BreakGlassGrant,
    decision: GrantDecision,
    trigger: HTMLElement | null,
  ) {
    const verbs = {
      approve: "Approve",
      deny: "Deny",
      revoke: grant.status === "pending" ? "Withdraw" : "Revoke",
    };
    const yes = await confirm(
      {
        title: `${verbs[decision]} break-glass access to ${grant.team.name}?`,
        ...(grant.legalHold
          ? { description: "This is a legal hold: the subject is not notified." }
          : {}),
        confirmLabel: verbs[decision],
        tone: decision === "approve" ? "primary" : "danger",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => decideGrant(grant.id, decision),
      ({ grant: g, warnings }) =>
        [`${STATUS_LABELS[g.status]}: ${g.team.name}.`, ...warnings.map((w) => w.message)].join(
          " ",
        ),
    );
    if (done) {
      if (reading?.id === grant.id) setReading(null);
      reload();
    }
  }

  if (reading) {
    return (
      <BreakGlassReader
        grant={reading}
        onClose={() => {
          setReading(null);
          reload();
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Break-glass"
        description="Site admins can't read team content. Break-glass gives one site admin read-only access to one team for a limited time, after a second site admin approves. The team's admins are notified, and every read is recorded in the team's audit log."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="break-glass grants">
        {(data) => (
          <>
            <RequestForm
              teams={data.teams}
              soleAdmin={data.selfApprovalAllowed}
              mutation={mutation}
              onRequested={reload}
            />
            <Section title="Requests and grants">
              <GrantTable
                grants={data.grants}
                onDecide={(g, decision, trigger) => void decide(g, decision, trigger)}
                onRead={setReading}
                pending={mutation.pending}
              />
            </Section>
          </>
        )}
      </ResourceView>
      {confirmDialog}
    </>
  );
}

type Mutation = ReturnType<typeof useMutation>;

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
  const [scope, setScope] = useState<GrantScope>("team");
  const [userId, setUserId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState(60);
  const [legalHold, setLegalHold] = useState(false);
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
        requestGrant({
          teamId,
          reason: reason.trim(),
          durationMinutes: duration,
          legalHold,
          userId: scope === "user" ? userId : undefined,
          threadId: scope === "thread" ? threadId.trim() : undefined,
        }),
      ({ grant: g }) =>
        soleAdmin
          ? `Requested access to ${g.team.name}. You are the only site admin: you can approve it yourself (it will be flagged).`
          : `Requested access to ${g.team.name}. A second site admin must approve it.`,
    );
    if (done) {
      setReason("");
      setScope("team");
      setUserId("");
      setThreadId("");
      setLegalHold(false);
      onRequested();
    }
  }

  return (
    <Section title="Request access">
      <form onSubmit={onSubmit} aria-label="Request break-glass access">
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
            {(["team", "user", "thread"] as const).map((s) => (
              <Radio
                key={s}
                name="scope"
                value={s}
                label={
                  s === "team" ? "Whole team" : s === "user" ? "One user's threads" : "One thread"
                }
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
          {scope === "thread" && (
            <Field label="Thread id">
              <TextInput required value={threadId} onChange={(e) => setThreadId(e.target.value)} />
            </Field>
          )}
          <Field label="Duration">
            <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {durationLabel(d)}
                </option>
              ))}
            </Select>
          </Field>
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
        <Checkbox
          className="mb-3"
          label="Legal hold (don't notify the user being investigated)"
          checked={legalHold}
          onChange={(e) => setLegalHold(e.target.checked)}
        />
        <div>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            Request access
          </Button>
        </div>
      </form>
      {soleAdmin && (
        <p className="text-sm text-console-muted">
          You are this site&apos;s only active admin, so you can approve your own request. The grant
          is flagged as self-approved everywhere it appears.
        </p>
      )}
    </Section>
  );
}

function GrantTable({
  grants,
  onDecide,
  onRead,
  pending,
}: {
  readonly grants: readonly BreakGlassGrant[];
  readonly onDecide: (
    grant: BreakGlassGrant,
    decision: GrantDecision,
    trigger: HTMLElement | null,
  ) => void;
  readonly onRead: (grant: BreakGlassGrant) => void;
  readonly pending: boolean;
}) {
  if (grants.length === 0) return <EmptyState title="No break-glass requests yet." />;
  return (
    <Table caption="Requests and grants" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Team</TableHeader>
          <TableHeader>Requested by</TableHeader>
          <TableHeader>Scope</TableHeader>
          <TableHeader>Reason</TableHeader>
          <TableHeader>Status</TableHeader>
          <TableHeader>Window</TableHeader>
          <TableHeader>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {grants.map((g) => (
          <TableRow key={g.id}>
            <TableCell>{g.team.name}</TableCell>
            <TableCell>
              {g.requestedBy.name}
              <br />
              <span className="text-sm text-console-muted">
                <DateTime value={g.requestedAt} />
              </span>
            </TableCell>
            <TableCell>
              {scopeLabel(g)}
              {g.legalHold && (
                <>
                  <br />
                  <strong>Legal hold:</strong> the subject is not notified
                </>
              )}
            </TableCell>
            <TableCell>{g.reason}</TableCell>
            <TableCell>
              <Badge tone={STATUS_TONES[g.status]}>{STATUS_LABELS[g.status]}</Badge>
              {g.approvedBy && (
                <>
                  <br />
                  <span className="text-sm text-console-muted">
                    {g.selfApproved
                      ? `Self-approved by ${g.approvedBy.name} (flagged)`
                      : `Approved by ${g.approvedBy.name}`}
                  </span>
                </>
              )}
            </TableCell>
            <TableCell>
              {g.startsAt ? (
                <>
                  <DateTime value={g.startsAt} /> – <DateTime value={g.endedAt ?? g.expiresAt} />
                </>
              ) : (
                durationLabel(g.durationMinutes)
              )}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1.5">
                {g.actions.read && (
                  <Button size="sm" variant="primary" onClick={() => onRead(g)}>
                    Read
                  </Button>
                )}
                {g.actions.approve && (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={(e) => onDecide(g, "approve", eventTrigger(e))}
                  >
                    Approve
                  </Button>
                )}
                {g.actions.deny && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending}
                    onClick={(e) => onDecide(g, "deny", eventTrigger(e))}
                  >
                    Deny
                  </Button>
                )}
                {g.actions.revoke && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending}
                    onClick={(e) => onDecide(g, "revoke", eventTrigger(e))}
                  >
                    {g.status === "pending" ? "Withdraw" : "Revoke"}
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
