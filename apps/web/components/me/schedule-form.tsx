"use client";

import { SCHEDULE_PROMPT_MAX, SCHEDULE_WEEKDAYS, type ScheduleRecurrence } from "@kobe/protocol";
import { useState, type FormEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import type { Schedule, ScheduleAgent, ScheduleDraft } from "../../lib/schedules/api";
import {
  PRESET_LABELS,
  WEEKDAY_LABELS,
  browserTimeZone,
  timeZoneOptions,
  type PresetKind,
} from "../../lib/schedules/format";
import { ErrorNotice } from "../admin/error-notice";
import {
  Button,
  Card,
  Checkbox,
  ChoiceGroup,
  Field,
  FormRow,
  Select,
  TextInput,
  Textarea,
} from "../ui/console";

const DEFAULT_TIME = "09:00";
const DEFAULT_CRON = "0 9 * * 1-5";
const PRESETS = Object.keys(PRESET_LABELS) as PresetKind[];

function initialDays(r: ScheduleRecurrence | undefined): readonly string[] {
  return r?.kind === "weekly" ? r.days : [];
}

function timeOf(r: ScheduleRecurrence | undefined): string {
  return r !== undefined && r.kind !== "cron" ? r.at : DEFAULT_TIME;
}

function buildRecurrence(
  kind: PresetKind,
  at: string,
  days: readonly string[],
  expr: string,
): ScheduleRecurrence {
  if (kind === "cron") return { kind, expr: expr.trim() };
  if (kind === "weekly") {
    const picked = SCHEDULE_WEEKDAYS.filter((d) => days.includes(d));
    return { kind, days: picked, at };
  }
  return { kind, at };
}

/** Create or edit one schedule. Prompt and agent names render as plain text (React escapes). */
export function ScheduleForm({
  editing,
  agents,
  error,
  pending,
  onSubmit,
  onCancel,
}: {
  readonly editing: Schedule | null;
  readonly agents: readonly ScheduleAgent[];
  readonly error: ApiError | null;
  readonly pending: boolean;
  readonly onSubmit: (draft: ScheduleDraft) => void;
  readonly onCancel: () => void;
}) {
  const r = editing?.recurrence;
  const [agentId, setAgentId] = useState(editing?.agentId ?? "");
  const [prompt, setPrompt] = useState(editing?.prompt ?? "");
  const [kind, setKind] = useState<PresetKind>(r?.kind ?? "daily");
  const [at, setAt] = useState(timeOf(r));
  const [days, setDays] = useState<readonly string[]>(initialDays(r));
  const [expr, setExpr] = useState(r?.kind === "cron" ? r.expr : DEFAULT_CRON);
  const [tz, setTz] = useState(editing?.tz ?? browserTimeZone());
  const [notifyEmail, setNotifyEmail] = useState(editing?.notifyEmail ?? false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      agentId,
      prompt,
      recurrence: buildRecurrence(kind, at, days, expr),
      tz,
      notifyEmail,
    });
  };
  const toggleDay = (d: string) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  return (
    <Card className="my-4">
      <form onSubmit={submit} aria-label={editing ? "Edit schedule" : "New schedule"}>
        <FormRow className="mt-0">
          <Field label="Agent">
            <Select value={agentId} required onChange={(e) => setAgentId(e.target.value)}>
              <option value="" disabled>
                Choose an agent
              </option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>
        <Field label="Prompt" className="mb-4 max-w-2xl">
          <Textarea
            value={prompt}
            required
            rows={4}
            maxLength={SCHEDULE_PROMPT_MAX}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <FormRow>
          <Field label="Repeats">
            <Select value={kind} onChange={(e) => setKind(e.target.value as PresetKind)}>
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "cron" ? (
            <Field
              label="Cron expression"
              hint="Five fields: minute hour day month weekday, in the time zone below."
            >
              <TextInput value={expr} required onChange={(e) => setExpr(e.target.value)} />
            </Field>
          ) : (
            <Field label="At">
              <TextInput type="time" value={at} required onChange={(e) => setAt(e.target.value)} />
            </Field>
          )}
          <Field label="Time zone">
            <Select value={tz} onChange={(e) => setTz(e.target.value)}>
              {timeZoneOptions(tz).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>
        {kind === "weekly" && (
          <ChoiceGroup legend="On" className="mb-4">
            {SCHEDULE_WEEKDAYS.map((d) => (
              <Checkbox
                key={d}
                label={WEEKDAY_LABELS[d]}
                checked={days.includes(d)}
                onChange={() => toggleDay(d)}
              />
            ))}
          </ChoiceGroup>
        )}
        <Checkbox
          label="Email me when a run ends"
          hint="Every run also shows up under the bell in the chat. The email says how the run ended and links to its conversation; it never includes the prompt or the answer."
          checked={notifyEmail}
          onChange={(e) => setNotifyEmail(e.target.checked)}
        />
        {error && <ErrorNotice error={error} />}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            Save schedule
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
