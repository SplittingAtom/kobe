"use client";

import { useState } from "react";
import {
  commentOn,
  decideVersion,
  type DecisionAction,
  type ReviewDetail,
} from "../../../lib/admin/api/site/skill-review";
import {
  Button,
  Checkbox,
  ChoiceGroup,
  Field,
  Notice,
  Section,
  Textarea,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import type { Mutation } from "../use-resource";

const DONE: Readonly<Record<DecisionAction, string>> = {
  approve: "Approved: the version is in the Site catalog.",
  request_changes: "Sent back to the author's Workbench with your note.",
  reject: "Rejected.",
  reject_and_block: "Rejected, and its runtime hash is on the site blocklist.",
};

/**
 * The review's decisions (SK23): the checklist, a note, Approve (off, with the reasons, while the
 * caller can't approve), Request changes (needs the note), Reject, and Reject and block for those
 * who may block (Site admins). Comment adds a note without a decision.
 */
export function ReviewActions({
  detail,
  mayBlock,
  mutation,
  onChanged,
}: {
  readonly detail: ReviewDetail;
  readonly mayBlock: boolean;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [needNote, setNeedNote] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const open = detail.state === "submitted" || detail.state === "in_review";
  if (!open) return null;

  async function decide(action: DecisionAction, trigger: HTMLElement | null) {
    if (action === "request_changes" && note.trim() === "") {
      setNeedNote(true);
      return;
    }
    setNeedNote(false);
    if (action === "reject_and_block") {
      const yes = await confirm(
        {
          title: `Reject ${detail.skill.name} ${detail.semver} and block its hash everywhere?`,
          confirmLabel: "Reject and block",
        },
        trigger,
      );
      if (!yes) return;
    }
    const checklist = Object.fromEntries(
      detail.checklist.map((c) => [c.id, ticked[c.id] === true]),
    );
    const done = await mutation.run(
      () =>
        decideVersion(detail.id, {
          action,
          ...(note.trim() ? { note: note.trim() } : {}),
          checklist,
        }),
      () => DONE[action],
    );
    if (done) onChanged();
  }

  async function addComment() {
    if (note.trim() === "") {
      setNeedNote(true);
      return;
    }
    const done = await mutation.run(
      () => commentOn(detail.id, note.trim()),
      () => "Comment added.",
    );
    if (done) {
      setNote("");
      onChanged();
    }
  }

  const blocked = detail.approveProblems.length > 0;
  return (
    <Section title="Decision">
      <ChoiceGroup legend="Checklist" stacked>
        {detail.checklist.map((c) => (
          <Checkbox
            key={c.id}
            label={c.label}
            checked={ticked[c.id] === true}
            onChange={(e) => setTicked({ ...ticked, [c.id]: e.target.checked })}
          />
        ))}
      </ChoiceGroup>
      <Field
        label="Note"
        hint="Request changes sends it to the author's Workbench."
        error={needNote ? "Write a note for the author first." : null}
      >
        <Textarea maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {blocked && (
        <Notice tone="info" role="status">
          You can&apos;t approve this yet:
          <ul className="mt-1 list-disc ps-6">
            {detail.approveProblems.map((p) => (
              <li key={p.code}>{p.message}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={blocked || mutation.pending}
          onClick={(e) => void decide("approve", eventTrigger(e))}
        >
          Approve
        </Button>
        <Button
          disabled={mutation.pending}
          onClick={(e) => void decide("request_changes", eventTrigger(e))}
        >
          Request changes
        </Button>
        <Button disabled={mutation.pending} onClick={(e) => void decide("reject", eventTrigger(e))}>
          Reject
        </Button>
        {mayBlock && (
          <Button
            variant="danger"
            disabled={mutation.pending}
            onClick={(e) => void decide("reject_and_block", eventTrigger(e))}
          >
            Reject and block
          </Button>
        )}
        <Button disabled={mutation.pending} onClick={() => void addComment()}>
          Comment
        </Button>
      </div>
      {confirmDialog}
    </Section>
  );
}
