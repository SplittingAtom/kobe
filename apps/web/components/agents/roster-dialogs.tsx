"use client";

import {
  AGENT_ROSTER_NOTE_MAX,
  type AgentRosterRow,
  type AgentVersionRuleInput,
} from "@kobe/protocol";
import { useState } from "react";
import { listMyTeamsForEval } from "../../lib/admin/api/site/gallery";
import { Button, Dialog, DialogClose, Field, Select, Textarea } from "../ui/console";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";

const LATEST = "latest";

/** The versions an entry can be pinned to: the agent's published ones, newest first. */
export function pinChoices(currentVersion: number | null): number[] {
  if (currentVersion === null) return [];
  return Array.from({ length: currentVersion }, (_, i) => currentVersion - i);
}

const ruleOf = (choice: string): AgentVersionRuleInput =>
  choice === LATEST ? LATEST : Number(choice);

/** "Latest published version" or "Pin to vN", newest first (AR5). */
function VersionRuleField({
  row,
  value,
  onChange,
}: {
  readonly row: AgentRosterRow;
  readonly value: string;
  readonly onChange: (choice: string) => void;
}) {
  return (
    <Field label="Version rule">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={LATEST}>
          {row.currentVersion === null
            ? "Latest published version"
            : `Latest published version (now v${row.currentVersion})`}
        </option>
        {pinChoices(row.currentVersion).map((v) => (
          <option key={v} value={String(v)}>
            {`Pin to v${v}`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Approve a proposal (§6.4): it follows the latest published version unless the admin pins one.
 */
export function ApproveDialog({
  row,
  rosterName,
  returnFocus,
  pending,
  onClose,
  onApprove,
}: {
  readonly row: AgentRosterRow;
  readonly rosterName: string;
  readonly returnFocus: HTMLElement | null;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onApprove: (rule: AgentVersionRuleInput) => Promise<void>;
}) {
  const [choice, setChoice] = useState<string>(LATEST);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Approve ${row.name} for ${rosterName}?`}
      description="Members can then start it here. It follows each new publish unless you pin a version."
      returnFocus={() => returnFocus}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onApprove(ruleOf(choice));
        }}
      >
        <VersionRuleField row={row} value={choice} onChange={setChoice} />
        <div className="flex flex-wrap justify-end gap-2">
          <DialogClose asChild>
            <Button type="button">Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" loading={pending}>
            Approve
          </Button>
        </div>
      </form>
    </Dialog>
  );
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
          void onPin(ruleOf(choice));
        }}
      >
        <VersionRuleField row={row} value={choice} onChange={setChoice} />
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

/**
 * Run a gallery agent's Orbit eval (KOBE-94) in a team the site admin belongs to: its sandbox
 * runtime and model budget. The active team comes first; the Gallery page's picker (KOBE-570).
 */
export function EvalDialog({
  row,
  activeTeamId,
  returnFocus,
  pending,
  onClose,
  onRun,
}: {
  readonly row: AgentRosterRow;
  readonly activeTeamId: string;
  readonly returnFocus: HTMLElement | null;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onRun: (team: { readonly id: string; readonly name: string }) => Promise<void>;
}) {
  const { state } = useResource(listMyTeamsForEval);
  const [choice, setChoice] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Run an eval of ${row.name}`}
      description="The eval runs in a team you belong to (its sandbox runtime and model budget) and takes several minutes; the score appears here when it finishes."
      returnFocus={() => returnFocus}
    >
      <ResourceView state={state} label="your teams">
        {({ teams }) => {
          const fallback = teams.find((t) => t.id === activeTeamId) ?? teams[0];
          const teamId = choice ?? fallback?.id ?? "";
          const team = teams.find((t) => t.id === teamId);
          return (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (team) void onRun({ id: team.id, name: team.name });
              }}
            >
              <Field label="Run in team">
                <Select value={teamId} onChange={(e) => setChoice(e.target.value)}>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex flex-wrap justify-end gap-2">
                <DialogClose asChild>
                  <Button type="button">Cancel</Button>
                </DialogClose>
                <Button type="submit" variant="primary" loading={pending} disabled={!team}>
                  Run eval
                </Button>
              </div>
            </form>
          );
        }}
      </ResourceView>
    </Dialog>
  );
}
