"use client";

import {
  AGENT_ROSTER_NOTE_MAX,
  type AgentRosterRow,
  type AgentVersionRuleInput,
} from "@kobe/protocol";
import { useState } from "react";
import { Button, Dialog, DialogClose, Field, Select, Textarea } from "../ui/console";

const LATEST = "latest";

/** The versions an entry can be pinned to: the agent's published ones, newest first. */
export function pinChoices(currentVersion: number | null): number[] {
  if (currentVersion === null) return [];
  return Array.from({ length: currentVersion }, (_, i) => currentVersion - i);
}

/**
 * Pin a roster entry to a published version, or let it follow the latest (AR5, version rule).
 * Opened from a row's "Pin a version…" by the roster's admins.
 */
export function PinDialog({
  row,
  rosterName,
  returnFocus,
  pending,
  onClose,
  onPin,
}: {
  readonly row: AgentRosterRow;
  readonly rosterName: string;
  readonly returnFocus: HTMLElement | null;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onPin: (rule: AgentVersionRuleInput) => Promise<void>;
}) {
  const pinned = row.entry?.versionRule === "pinned" ? row.entry.pinnedVersion : null;
  const [choice, setChoice] = useState<string>(pinned === null ? LATEST : String(pinned));
  const versions = pinChoices(row.currentVersion);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Version of ${row.name} on ${rosterName}`}
      description="Following the latest version brings each new publish to members at once; a pin keeps this roster on one version. Threads already started keep theirs."
      returnFocus={() => returnFocus}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onPin(choice === LATEST ? LATEST : Number(choice));
        }}
      >
        <Field label="Version rule">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value={LATEST}>
              {row.currentVersion === null
                ? "Latest published version"
                : `Latest published version (now v${row.currentVersion})`}
            </option>
            {versions.map((v) => (
              <option key={v} value={String(v)}>
                {`Pin to v${v}`}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <DialogClose asChild>
            <Button type="button">Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" loading={pending}>
            Save version rule
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Decline a proposal with an optional note the proposer sees (§6.4). */
export function DeclineDialog({
  row,
  rosterName,
  returnFocus,
  pending,
  onClose,
  onDecline,
}: {
  readonly row: AgentRosterRow;
  readonly rosterName: string;
  readonly returnFocus: HTMLElement | null;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onDecline: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Decline ${row.name} for ${rosterName}?`}
      description="The proposer sees your note beside the agent in their Personal tab."
      returnFocus={() => returnFocus}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onDecline(note.trim());
        }}
      >
        <Field label="Note (optional)">
          <Textarea
            value={note}
            maxLength={AGENT_ROSTER_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <DialogClose asChild>
            <Button type="button">Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="danger" loading={pending}>
            Decline
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
