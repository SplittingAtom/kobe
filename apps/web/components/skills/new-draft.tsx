"use client";

import { SKILL_NAME_PATTERN as SKILL_NAME } from "@kobe/protocol";
import { useState } from "react";
import type { ApiResult } from "../../lib/api/client";
import {
  createDraft,
  listTemplates,
  uploadDraft,
  type DraftSummary,
} from "../../lib/skills/drafts-api";
import { Button, Field, Section, Select, TextInput } from "../ui/console";
import { MutationStatus } from "../admin/error-notice";
import { useMutation, useResource } from "../admin/use-resource";
import { draftHref } from "./draft-href";
import { useNavigate } from "../shell/use-navigate";

const BLANK = "";

/** Opens the draft a start made (client-side: the panel stays, KOBE-452). */
function useOpenDraft(): (res: ApiResult<DraftSummary>) => ApiResult<DraftSummary> {
  const navigate = useNavigate();
  return (res) => {
    if (res.ok) navigate(draftHref(res.data.id));
    return res;
  };
}

/**
 * Starting a draft in the Workbench (KOBE-322, SK10): blank, from one of the templates, or from
 * an uploaded zip or SKILL.md (checked as an upload is). Forks start from the Team and Mine tabs,
 * and a conversation's skill from the thread's menu.
 */
export function NewDraft({ teamId }: { readonly teamId: string }) {
  return (
    <Section title="New draft" level={2}>
      <StartForm teamId={teamId} />
      <UploadForm teamId={teamId} />
    </Section>
  );
}

function StartForm({ teamId }: { readonly teamId: string }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(BLANK);
  const [attempted, setAttempted] = useState(false);
  const mutation = useMutation();
  const opened = useOpenDraft();
  const { state } = useResource(() => listTemplates(teamId));
  const templates = state.status === "ready" ? state.data : [];
  const chosen = templates.find((t) => t.id === template);
  const invalid = !SKILL_NAME.test(name);
  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setAttempted(true);
        if (invalid) return;
        await mutation.run(async () =>
          opened(await createDraft(teamId, name, template === BLANK ? undefined : template)),
        );
      }}
    >
      <Field
        label="Skill name"
        hint="Lowercase letters, digits and hyphens, such as report-writer."
        error={attempted && invalid ? "Use lowercase letters, digits and hyphens." : undefined}
      >
        <TextInput type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Start from" hint={chosen?.summary ?? "An empty SKILL.md to write yourself."}>
        <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
          <option value={BLANK}>Blank</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              Template: {t.title}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="primary" disabled={mutation.pending}>
        Start a draft
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}

function UploadForm({ teamId }: { readonly teamId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [attempted, setAttempted] = useState(false);
  const mutation = useMutation();
  const opened = useOpenDraft();
  return (
    <form
      noValidate
      className="mt-4 flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setAttempted(true);
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const kind = /\.zip$/i.test(file.name) ? "zip" : "skill_md";
        await mutation.run(async () => opened(await uploadDraft(teamId, bytes, kind)));
      }}
    >
      <Field
        label="Upload a zip or SKILL.md"
        hint="Checked as an upload is; the draft takes the name in its SKILL.md."
        error={attempted && !file ? "Choose a .zip or .md file." : undefined}
      >
        <TextInput
          type="file"
          accept=".zip,.md,application/zip,text/markdown"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <Button type="submit" disabled={mutation.pending}>
        Upload as a draft
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
