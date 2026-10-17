"use client";

import { useState, type FormEvent } from "react";
import { REMEMBER_SCOPE_LABELS, REMEMBER_SCOPES, type RememberScope } from "@kobe/protocol";
import type { ApiResult } from "../../lib/api/client";
import type { RememberLimits } from "../../lib/admin/api/remember";
import { Button, Checkbox, ChoiceGroup, Field, Select } from "../ui/console";
import { MutationStatus } from "./error-notice";
import { useMutation } from "./use-resource";

const HOUR = 3600;
/** Max durations an admin can pick (seconds); null = no limit. */
const DURATIONS: readonly { readonly label: string; readonly seconds: number | null }[] = [
  { label: "No limit", seconds: null },
  { label: "1 hour", seconds: HOUR },
  { label: "8 hours", seconds: 8 * HOUR },
  { label: "1 day", seconds: 24 * HOUR },
  { label: "7 days", seconds: 7 * 24 * HOUR },
  { label: "30 days", seconds: 30 * 24 * HOUR },
  { label: "90 days", seconds: 90 * 24 * HOUR },
];

const SCOPE_TEXT: Readonly<Record<RememberScope, string>> = {
  thread: "This conversation",
  today: "Until end of today",
  run: "This run only",
  day: "1 day",
  month: "30 days",
  forever: "Until revoked",
};

function durationLabel(seconds: number | null): string {
  return (
    DURATIONS.find((d) => d.seconds === seconds)?.label ??
    (seconds === null ? "No limit" : `${Math.round(seconds / HOUR)} hours`)
  );
}

/**
 * Which "remember" choices members may use on approval cards (KOBE-289 ac-5): scopes, a max
 * duration, MCP tools, exact actions only, and "Approve all waiting". On the team page `floor` is
 * the site floor: what it forbids is shown and can't be picked (a team only tightens it; the
 * server refuses a looser save and applies the stricter of both either way).
 */
export function RememberLimitsForm({
  label,
  initial,
  floor,
  save,
  onSaved,
}: {
  readonly label: string;
  readonly initial: RememberLimits;
  readonly floor?: RememberLimits | undefined;
  readonly save: (limits: RememberLimits) => Promise<ApiResult<unknown>>;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [limits, setLimits] = useState<RememberLimits>(initial);
  const floorMax = floor?.maxDurationSeconds ?? null;
  const scopeAllowed = (s: RememberScope) => floor === undefined || floor.scopes.includes(s);
  const durationAllowed = (seconds: number | null) =>
    floorMax === null || (seconds !== null && seconds <= floorMax);
  const set = (next: Partial<RememberLimits>) => setLimits((l) => ({ ...l, ...next }));
  const toggle = (s: RememberScope, on: boolean) =>
    set({
      scopes: REMEMBER_SCOPES.filter((x) => (x === s ? on : limits.scopes.includes(x))),
    });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => save(floor === undefined ? limits : withinFloor(limits, floor)),
      () => "Saved. Approval cards offer only these choices from now on.",
    );
    if (done) onSaved();
  }

  const options = DURATIONS.some((d) => d.seconds === limits.maxDurationSeconds)
    ? DURATIONS
    : [
        ...DURATIONS,
        { label: durationLabel(limits.maxDurationSeconds), seconds: limits.maxDurationSeconds },
      ];

  return (
    <form onSubmit={onSubmit} aria-label={label}>
      <ChoiceGroup
        legend="Members may remember an approval for"
        hint="Unticked choices are not offered on approval cards, and the server refuses them. Rules already made with them stop applying."
        stacked
      >
        {REMEMBER_SCOPES.map((s) => (
          <Checkbox
            key={s}
            label={SCOPE_TEXT[s]}
            checked={limits.scopes.includes(s) && scopeAllowed(s)}
            disabled={!scopeAllowed(s)}
            hint={scopeAllowed(s) ? undefined : "Not allowed by the site floor."}
            onChange={(e) => toggle(s, e.target.checked)}
          />
        ))}
      </ChoiceGroup>
      <Field
        label="Longest a remembered approval may last"
        hint={`Counted from when it was made; "${REMEMBER_SCOPE_LABELS.forever}" is not offered with a limit.${floorMax === null ? "" : ` The site floor allows at most ${durationLabel(floorMax)}.`}`}
        className="my-4 max-w-sm"
      >
        <Select
          value={limits.maxDurationSeconds === null ? "" : String(limits.maxDurationSeconds)}
          onChange={(e) =>
            set({ maxDurationSeconds: e.target.value === "" ? null : Number(e.target.value) })
          }
        >
          {options.map((d) => (
            <option
              key={d.label}
              value={d.seconds === null ? "" : String(d.seconds)}
              disabled={!durationAllowed(d.seconds)}
            >
              {d.label}
            </option>
          ))}
        </Select>
      </Field>
      <ChoiceGroup legend="Also" stacked>
        <Checkbox
          label="Members may remember approvals of connector (MCP) tools"
          checked={limits.mcpTools && floor?.mcpTools !== false}
          disabled={floor?.mcpTools === false}
          hint={floor?.mcpTools === false ? "Not allowed by the site floor." : undefined}
          onChange={(e) => set({ mcpTools: e.target.checked })}
        />
        <Checkbox
          label="Remember only exact actions (the same command, path or arguments)"
          checked={limits.exactOnly || floor?.exactOnly === true}
          disabled={floor?.exactOnly === true}
          hint={floor?.exactOnly === true ? "Required by the site floor." : undefined}
          onChange={(e) => set({ exactOnly: e.target.checked })}
        />
        <Checkbox
          label={'Offer "Approve all waiting" when several calls of a run wait'}
          checked={limits.approveAll && floor?.approveAll !== false}
          disabled={floor?.approveAll === false}
          hint={
            floor?.approveAll === false
              ? "Not allowed by the site floor."
              : "Never for tools that can delete data or reach outside Kobe."
          }
          onChange={(e) => set({ approveAll: e.target.checked })}
        />
      </ChoiceGroup>
      <div className="my-4">
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Save limits
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}

/** Values a team may save under `floor`: whatever the floor forbids, forbidden (the server agrees). */
export function withinFloor(limits: RememberLimits, floor: RememberLimits): RememberLimits {
  const max =
    floor.maxDurationSeconds === null
      ? limits.maxDurationSeconds
      : Math.min(limits.maxDurationSeconds ?? floor.maxDurationSeconds, floor.maxDurationSeconds);
  return {
    scopes: limits.scopes.filter((s) => floor.scopes.includes(s)),
    maxDurationSeconds: max,
    mcpTools: limits.mcpTools && floor.mcpTools,
    exactOnly: limits.exactOnly || floor.exactOnly,
    approveAll: limits.approveAll && floor.approveAll,
  };
}
