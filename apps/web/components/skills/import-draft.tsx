"use client";

import { useState } from "react";
import { importDraft } from "../../lib/skills/drafts-api";
import { Button, Field, Select, TextInput } from "../ui/console";
import { MutationStatus } from "../admin/error-notice";
import { useMutation } from "../admin/use-resource";
import { useOpenDraft } from "./new-draft";

/**
 * Governed import (KOBE-344, SK30): Builders import a git repository at a full commit SHA (and a
 * folder in it), or a zip URL with its SHA-256, from the hosts the Site allows. Kobe fetches it
 * once, re-hashes it and opens a private draft that records where it came from; evals, a version
 * and review follow as for any draft. Public hubs are only places to find skills.
 */
export const IMPORT_HINT =
  "Only hosts on the site's import allowlist. A branch or tag is never used: give the full commit SHA.";

export function ImportForm({ teamId }: { readonly teamId: string }) {
  const [kind, setKind] = useState<"git" | "zip">("git");
  const [url, setUrl] = useState("");
  const [pin, setPin] = useState("");
  const [folder, setFolder] = useState("");
  const mutation = useMutation();
  const opened = useOpenDraft();
  return (
    <form
      noValidate
      aria-label="Import a skill"
      className="mt-4 flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const request =
          kind === "git"
            ? {
                kind,
                url: url.trim(),
                commit: pin.trim().toLowerCase(),
                ...(folder.trim() ? { path: folder.trim() } : {}),
              }
            : { kind, url: url.trim(), sha256: pin.trim().toLowerCase() };
        await mutation.run(async () => opened(await importDraft(teamId, request)));
      }}
    >
      <Field label="Import from" hint={IMPORT_HINT}>
        <Select value={kind} onChange={(e) => setKind(e.target.value as "git" | "zip")}>
          <option value="git">Git repository</option>
          <option value="zip">Zip URL</option>
        </Select>
      </Field>
      <Field label={kind === "git" ? "Repository URL (https)" : "Zip URL (https)"}>
        <TextInput type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label={kind === "git" ? "Commit SHA" : "SHA-256 of the zip"}>
        <TextInput value={pin} onChange={(e) => setPin(e.target.value)} />
      </Field>
      {kind === "git" && (
        <Field
          label="Folder (optional)"
          hint="Where the skill is in the repository, such as skills/pdf."
        >
          <TextInput value={folder} onChange={(e) => setFolder(e.target.value)} />
        </Field>
      )}
      <Button type="submit" disabled={mutation.pending}>
        Import as a draft
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
