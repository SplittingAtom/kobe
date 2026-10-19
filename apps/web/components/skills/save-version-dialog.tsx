"use client";

import { useEffect, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { SkillSaved } from "../../lib/admin/api/team/skills";
import {
  saveDraftVersion,
  suggestBump,
  type BumpSuggestion,
  type Destination,
  type DraftSummary,
} from "../../lib/skills/drafts-api";
import {
  Button,
  Checkbox,
  ChoiceGroup,
  Dialog,
  DialogClose,
  Field,
  Radio,
  Textarea,
  TextInput,
} from "../ui/console";
import { ErrorNotice } from "../admin/error-notice";

const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const CHANGELOG_MAX = 1024;

/** What the suggestion says, in words (SK14). */
export function bumpText(b: BumpSuggestion, destination: Destination): string {
  const where = destination === "team" ? "team skill" : "personal skill";
  if (!b.latest) return `A new ${where}: its first version.`;
  if (!b.kind) return `Nothing changed since ${b.latest.semver}, the latest version.`;
  return `Suggested: a ${b.kind} version after ${b.latest.semver}, because ${b.reasons.join("; ")}.`;
}

/**
 * Save version (KOBE-321, SK11, SK14): the author picks the destination (a team skill, which goes
 * to review, or their personal skill), Kobe suggests the number from what changed, and the
 * changelog line is required. Pending edits are saved first, and the save names that revision.
 */
interface FormProps {
  readonly teamId: string;
  readonly teamName: string;
  readonly draft: DraftSummary;
  readonly canTeam: boolean;
  readonly canPersonal: boolean;
  readonly flush: () => Promise<number | null>;
  readonly onSaved: (saved: SkillSaved, destination: Destination) => void;
}

const UNSAVED: ApiError = {
  status: 0,
  code: "unsaved_changes",
  message: "Your latest edits aren't saved yet. Fix that, then save the version.",
};

export function SaveVersionDialog({
  open,
  onOpenChange,
  returnFocus,
  ...form
}: FormProps & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocus?: () => HTMLElement | null;
}) {
  // The form mounts each time the dialog opens, so nothing from the last save stays (review S5).
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Save ${form.draft.name} as a version`}
      description="Each version is immutable. A team version waits for a Team admin's review."
      {...(returnFocus ? { returnFocus } : {})}
    >
      <SaveVersionForm {...form} />
    </Dialog>
  );
}

type BumpState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly bump: BumpSuggestion }
  | { readonly status: "error"; readonly error: ApiError };

function SaveVersionForm({
  teamId,
  teamName,
  draft,
  canTeam,
  canPersonal,
  flush,
  onSaved,
}: FormProps) {
  const [destination, setDestination] = useState<Destination>(canTeam ? "team" : "personal");
  const [semver, setSemver] = useState("");
  const [touched, setTouched] = useState(false);
  const [changelog, setChangelog] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [askConfirm, setAskConfirm] = useState<string | null>(null);
  const [bump, setBump] = useState<BumpState>({ status: "loading" });
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  // The suggestion fills the number until the author types their own.
  const version = touched ? semver : bump.status === "ready" ? (bump.bump.suggested ?? "") : "";

  useEffect(() => {
    let current = true;
    void (async () => {
      const rev = await flush();
      if (!current) return;
      if (rev === null) return setBump({ status: "error", error: UNSAVED });
      const res = await suggestBump(teamId, draft.id, destination);
      if (current)
        setBump(
          res.ok ? { status: "ready", bump: res.data } : { status: "error", error: res.error },
        );
    })();
    return () => {
      current = false;
    };
  }, [destination, teamId, draft.id, flush]);

  const personalWarning =
    destination === "personal" && (draft.fromConversation || draft.coEdited || askConfirm !== null);
  const semverError =
    attempted && !SEMVER.test(version) ? "Give MAJOR.MINOR.PATCH, such as 1.2.0." : null;
  const changelogError =
    attempted && (changelog.trim() === "" || changelog.length > CHANGELOG_MAX)
      ? "Say what changed, in up to 1,024 characters."
      : null;

  async function submit() {
    setAttempted(true);
    setFailure(null);
    if (!SEMVER.test(version) || changelog.trim() === "" || changelog.length > CHANGELOG_MAX)
      return;
    setPending(true);
    const rev = await flush();
    if (rev === null) {
      setPending(false);
      setFailure(UNSAVED);
      return;
    }
    const res = await saveDraftVersion(teamId, draft.id, rev, {
      destination,
      semver: version,
      changelog: changelog.trim(),
      ...(destination === "personal" && confirmed ? { confirmPersonal: true } : {}),
    });
    setPending(false);
    if (res.ok) {
      onSaved(res.data, destination);
      return;
    }
    if (res.error.code === "confirm_personal_required") setAskConfirm(res.error.message);
    setFailure(res.error);
  }

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ChoiceGroup legend="Save to" stacked>
        <Radio
          name="destination"
          label="Team skill"
          hint={`Shared with ${teamName} after review.`}
          checked={destination === "team"}
          disabled={!canTeam}
          onChange={() => {
            setBump({ status: "loading" });
            setDestination("team");
          }}
        />
        <Radio
          name="destination"
          label="My personal skill"
          hint="Only yours; it goes with you to every team."
          checked={destination === "personal"}
          disabled={!canPersonal}
          onChange={() => {
            setBump({ status: "loading" });
            setDestination("personal");
          }}
        />
      </ChoiceGroup>
      <div>
        <Field
          label="Version"
          hint="MAJOR.MINOR.PATCH, higher than the latest."
          error={semverError ?? undefined}
        >
          <TextInput
            type="text"
            value={version}
            onChange={(e) => {
              setTouched(true);
              setSemver(e.target.value);
            }}
          />
        </Field>
        <p className="m-0 mt-1 text-sm text-console-muted" role="status">
          {bump.status === "ready"
            ? bumpText(bump.bump, destination)
            : bump.status === "loading"
              ? "Working out the suggested version…"
              : `No suggestion: ${bump.error.message} Give the number yourself.`}
        </p>
      </div>
      <Field label="Changelog" hint="One line on what changed." error={changelogError ?? undefined}>
        <Textarea
          rows={2}
          className="w-full"
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
        />
      </Field>
      {personalWarning && (
        <Checkbox
          label="Save it as my personal skill anyway"
          hint={
            askConfirm ??
            `This draft ${draft.fromConversation ? `was started from a ${teamName} conversation` : `has changes by other ${teamName} members`}; personal skills go with you to every team.`
          }
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
      )}
      {failure && <ErrorNotice error={failure} />}
      <div className="flex flex-wrap justify-end gap-2">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending || undefined}>
          Save version
        </Button>
      </div>
    </form>
  );
}
