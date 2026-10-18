"use client";

import { useState, type FormEvent } from "react";
import { getTimeZone, listMyRules, putTimeZone, revokeMyRule } from "../../lib/admin/api/remember";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView } from "../admin/parts";
import { RememberedRules } from "../admin/remembered-rules";
import { useMutation, useResource } from "../admin/use-resource";
import { Button, Field, PageHeader, Section, TextInput } from "../ui/console";

const HEADING = "your-approvals";

/** This browser's IANA time zone, offered as a suggestion (the server stores what is saved). */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * My area, Approvals (KOBE-289 ac-4): the member's remembered approvals in the active team (tool,
 * how long, exact action, expiry, last use) with Revoke, and the time zone "until end of today"
 * uses. Revoking takes effect at the next tool call; the server enforces every scope.
 */
export function MyApprovalsPage() {
  const teamId = useTeamAccess().team.id;
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Approvals you asked Kobe to remember in this team. A remembered approval lets that tool run without asking, only in your own interactive conversations: never in scheduled or auto runs, and never past your team's deny or ask rules."
      />
      <Section id={HEADING} title="Remembered approvals">
        <RememberedRules
          caption="Your remembered approvals"
          headingId={HEADING}
          load={() => listMyRules(teamId)}
          revoke={(id) => revokeMyRule(teamId, id)}
          empty="Nothing remembered. Approval cards let you remember an approval for this conversation, today, this run or longer."
        />
      </Section>
      <Section
        title="Time zone"
        description='"Until end of today" ends at midnight in this time zone.'
      >
        <TimeZoneSetting />
      </Section>
    </>
  );
}

function TimeZoneSetting() {
  const { state, reload } = useResource(getTimeZone);
  return (
    <ResourceView state={state} label="your time zone">
      {(stored) => <TimeZoneForm stored={stored} onSaved={reload} />}
    </ResourceView>
  );
}

function TimeZoneForm({
  stored,
  onSaved,
}: {
  readonly stored: string | null;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const suggestion = browserTimeZone();
  const [value, setValue] = useState(stored ?? suggestion ?? "");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const zone = value.trim() === "" ? null : value.trim();
    const done = await mutation.run(
      () => putTimeZone(zone),
      (saved) => (saved === null ? "Saved: UTC." : `Saved: ${saved}.`),
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Time zone">
      <Field
        label="Your time zone"
        hint={`Now: ${stored ?? "UTC (not set)"}. An IANA name such as Europe/Berlin; empty for UTC.${suggestion && suggestion !== stored ? ` This browser is in ${suggestion}.` : ""}`}
        className="max-w-sm"
      >
        <TextInput
          maxLength={64}
          value={value}
          placeholder="Europe/Berlin"
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <div className="my-4">
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Save time zone
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
