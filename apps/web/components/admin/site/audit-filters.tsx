"use client";

import { useState, type FormEvent } from "react";
import {
  AUDIT_ACTION_PATTERN,
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditFilters,
} from "../../../lib/admin/api/site/audit";
import { Button, Field, FormRow, Select, TextInput } from "../../ui/console";

export interface FilterOption {
  readonly id: string;
  readonly label: string;
}

interface Draft {
  readonly action: string;
  readonly category: string;
  readonly actorId: string;
  readonly teamId: string;
  readonly since: string;
  readonly until: string;
}

const EMPTY: Draft = { action: "", category: "", actorId: "", teamId: "", since: "", until: "" };

const MINUTE_MS = 60_000;

/**
 * A `datetime-local` value (the viewer's time zone) as an ISO date-time, or undefined. With
 * `endOfMinute`, a value without seconds means the last millisecond of that minute, so "To 10:30"
 * includes an event at 10:30:45 (the server's bound is inclusive).
 */
export function localToIso(value: string, { endOfMinute = false } = {}): string | undefined {
  if (value === "") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const wholeMinute = endOfMinute && /T\d{2}:\d{2}$/.test(value);
  return new Date(date.getTime() + (wholeMinute ? MINUTE_MS - 1 : 0)).toISOString();
}

/** The viewer's time zone, for the From/To hint. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "your time zone";
  } catch {
    return "your time zone";
  }
}

type Errors = Partial<Record<"action" | "until", string>>;

function validate(draft: Draft): Errors {
  const errors: Errors = {};
  const action = draft.action.trim();
  if (action !== "" && !AUDIT_ACTION_PATTERN.test(action)) {
    errors.action = "Enter an action name such as sandbox.runtime_tampered.";
  }
  const since = localToIso(draft.since);
  const until = localToIso(draft.until, { endOfMinute: true });
  if (since && until && since > until) errors.until = "Choose a time after the start.";
  return errors;
}

function toFilters(draft: Draft): AuditFilters {
  const since = localToIso(draft.since);
  const until = localToIso(draft.until, { endOfMinute: true });
  const action = draft.action.trim();
  return {
    ...(action ? { action } : {}),
    ...(draft.category ? { category: draft.category as AuditCategory } : {}),
    ...(draft.actorId ? { actorId: draft.actorId } : {}),
    ...(draft.teamId ? { teamId: draft.teamId } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}

/**
 * Filters for the site audit log: action (exact name) or category, actor, team and a time range.
 * The server applies them (`GET /v1/site/audit`); nothing is filtered in the browser.
 */
export function AuditFilterForm({
  users,
  teams,
  busy,
  onApply,
}: {
  readonly users: readonly FilterOption[];
  readonly teams: readonly FilterOption[];
  readonly busy: boolean;
  readonly onApply: (filters: AuditFilters) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const set = (key: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [key]: e.target.value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const found = validate(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onApply(toFilters(draft));
  }

  function clear() {
    setDraft(EMPTY);
    setErrors({});
    onApply({});
  }

  return (
    <form aria-label="Filter the audit log" onSubmit={submit} noValidate>
      <FormRow>
        <Field
          label="Action"
          hint="The exact name, for example sandbox.runtime_tampered."
          error={errors.action}
          className="w-72"
        >
          <TextInput name="action" value={draft.action} onChange={set("action")} />
        </Field>
        <Field label="Category" className="w-44">
          <Select name="category" value={draft.category} onChange={set("category")}>
            <option value="">Any category</option>
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Actor" className="w-56">
          <Select name="actorId" value={draft.actorId} onChange={set("actorId")}>
            <option value="">Anyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Team" className="w-48">
          <Select name="teamId" value={draft.teamId} onChange={set("teamId")}>
            <option value="">Any team or the site</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
      </FormRow>
      <FormRow>
        <Field label="From" hint={`In ${viewerTimeZone()}.`} className="w-56">
          <TextInput
            type="datetime-local"
            name="since"
            value={draft.since}
            onChange={set("since")}
          />
        </Field>
        <Field label="To" hint="Includes the whole minute." error={errors.until} className="w-56">
          <TextInput
            type="datetime-local"
            name="until"
            value={draft.until}
            onChange={set("until")}
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            Apply filters
          </Button>
          <Button onClick={clear} disabled={busy}>
            Clear
          </Button>
        </div>
      </FormRow>
    </form>
  );
}
