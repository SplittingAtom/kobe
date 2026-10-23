"use client";

import { useEffect, useState } from "react";
import {
  publishSiteDraft,
  scanSiteDraft,
  suggestSiteBump,
  type SitePublished,
} from "../../../lib/admin/api/site/catalog-edit";
import type { ApiError } from "../../../lib/api/client";
import type { BumpSuggestion, ScanPreview } from "../../../lib/skills/drafts-api";
import { Findings } from "../../skills/feedback";
import { Button, Dialog, DialogClose, Field, Textarea, TextInput } from "../../ui/console";
import { ErrorNotice } from "../error-notice";

const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const CHANGELOG_MAX = 1024;

const UNSAVED: ApiError = {
  status: 0,
  code: "unsaved_changes",
  message: "Your latest edits aren't saved yet. Fix that, then save the version.",
};

/** What the suggestion says, in words. */
export function siteBumpText(b: BumpSuggestion): string {
  if (!b.latest) return "The skill's first version.";
  if (!b.kind) return `Nothing changed since ${b.latest.semver}, the newest version.`;
  return `Suggested: a ${b.kind} version after ${b.latest.semver}, because ${b.reasons.join("; ")}.`;
}

type BumpState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly bump: BumpSuggestion }
  | { readonly status: "error"; readonly error: ApiError };

interface FormProps {
  readonly skillId: string;
  readonly name: string;
  readonly flush: () => Promise<number | null>;
  readonly onSaved: (published: SitePublished) => void;
}

function SaveForm({ skillId, flush, onSaved }: FormProps) {
  const [semver, setSemver] = useState("");
  const [touched, setTouched] = useState(false);
  const [changelog, setChangelog] = useState("");
  const [bump, setBump] = useState<BumpState>({ status: "loading" });
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [blocked, setBlocked] = useState<ScanPreview | null>(null);
  const [pending, setPending] = useState(false);
  const version = touched ? semver : bump.status === "ready" ? (bump.bump.suggested ?? "") : "";

  useEffect(() => {
    let current = true;
    void (async () => {
      const rev = await flush();
      if (!current) return;
      if (rev === null) return setBump({ status: "error", error: UNSAVED });
      const res = await suggestSiteBump<BumpSuggestion>(skillId);
      if (current)
        setBump(
          res.ok ? { status: "ready", bump: res.data } : { status: "error", error: res.error },
        );
    })();
    return () => {
      current = false;
    };
  }, [skillId, flush]);

  const semverError =
    attempted && !SEMVER.test(version) ? "Give MAJOR.MINOR.PATCH, such as 1.2.0." : null;
  const changelogError =
    attempted && (changelog.trim() === "" || changelog.length > CHANGELOG_MAX)
      ? "Say what changed, in up to 1,024 characters."
      : null;

  async function submit() {
    setAttempted(true);
    setFailure(null);
    setBlocked(null);
    if (!SEMVER.test(version) || changelog.trim() === "" || changelog.length > CHANGELOG_MAX)
      return;
    setPending(true);
    const rev = await flush();
    if (rev === null) {
      setPending(false);
      setFailure(UNSAVED);
      return;
    }
    const res = await publishSiteDraft(skillId, rev, {
      semver: version,
      changelog: changelog.trim(),
    });
    setPending(false);
    if (res.ok) return onSaved(res.data.version);
    setFailure(res.error);
    // The findings that stopped it: the draft's scan, the same files and rules.
    if (res.error.code === "scan_block") {
      const scan = await scanSiteDraft<ScanPreview>(skillId);
      if (scan.ok) setBlocked(scan.data);
    }
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
      <div>
        <Field
          label="Version"
          hint="MAJOR.MINOR.PATCH, above every version of the skill."
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
            ? siteBumpText(bump.bump)
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
      {failure && <ErrorNotice error={failure} />}
      {blocked && <Findings scan={blocked} />}
      <div className="flex flex-wrap justify-end gap-2">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending || undefined}>
          Publish version
        </Button>
      </div>
    </form>
  );
}

/**
 * Save version of a site draft (KOBE-495): the admin confirms the number (suggested from the
 * change, as the Workbench does) and a changelog; the server validates, scans (a Block stops it
 * and its findings show here) and publishes it into the Catalog with publisher Site, no review.
 */
export function CatalogSaveDialog({
  open,
  onOpenChange,
  returnFocus,
  ...form
}: FormProps & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocus?: () => HTMLElement | null;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Publish ${form.name} as a new version`}
      description="Scanned, then published to the Catalog by the Site without review. Teams on Default get it; pinned installs stay as they are."
      {...(returnFocus ? { returnFocus } : {})}
    >
      <SaveForm {...form} />
    </Dialog>
  );
}
