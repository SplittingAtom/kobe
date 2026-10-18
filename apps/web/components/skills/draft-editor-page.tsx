"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type MouseEvent } from "react";
import type { SkillSaved } from "../../lib/admin/api/team/skills";
import type { ApiError } from "../../lib/api/client";
import { deleteDraft, type Destination } from "../../lib/skills/drafts-api";
import { lintSkill } from "../../lib/skills/lint";
import { SKILL_MD } from "../../lib/skills/skill-md";
import {
  Button,
  eventTrigger,
  Field,
  Notice,
  PageHeader,
  Switch,
  Textarea,
  useConfirm,
} from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { ErrorNotice, MutationStatus } from "../admin/error-notice";
import { useMutation } from "../admin/use-resource";
import { LintPanel, ScanPanel } from "./feedback";
import { FileTree } from "./file-tree";
import { SaveVersionDialog } from "./save-version-dialog";
import { SkillMdEditor } from "./skill-md-editor";
import { SkillTestPane } from "./test-pane";
import { useDraftEditor, type DraftEditor, type SaveStatus } from "./use-draft-editor";

export const WORKBENCH_HREF = "/me/skills?tab=workbench";

const STATUS_TEXT: Readonly<Record<SaveStatus, string>> = {
  saved: "All changes saved.",
  pending: "Unsaved changes…",
  saving: "Saving…",
  error: "Your latest change isn't saved.",
  conflict: "Not saved: someone else changed this draft.",
};

const Back = () => <Link href={WORKBENCH_HREF}>Workbench</Link>;
const NO_SCRIPTS: readonly string[] = [];

/** The Workbench editor of one draft (KOBE-321, SK12). */
export function DraftEditorPage({ draftId }: { readonly draftId: string }) {
  const teamId = useTeamAccess().team.id;
  const load = useDraftEditor(teamId, draftId);
  if (load.status === "ready") return <Editor editor={load.editor} />;
  return (
    <>
      <p className="m-0 mb-1 text-sm">
        <Back />
      </p>
      {load.status === "loading" ? (
        <p role="status">Loading the draft…</p>
      ) : (
        <ErrorNotice error={load.error} />
      )}
    </>
  );
}

function Editor({ editor }: { readonly editor: DraftEditor }) {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { draft, files, texts, scan } = editor;
  const [selected, setSelected] = useState(SKILL_MD);
  const [saving, setSaving] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const scripts =
    scan.status === "ready"
      ? scan.scan.scripts
      : scan.status === "idle"
        ? NO_SCRIPTS
        : (scan.last?.scripts ?? NO_SCRIPTS);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const skillMd = texts[SKILL_MD] ?? "";
  const lint = useMemo(() => lintSkill({ skillMd, paths, scripts }), [skillMd, paths, scripts]);
  const canTeam = access.permissions.includes("team.skills.publish");
  const canPersonal = draft.mine && access.permissions.includes("team.personal.create");

  const select = (path: string) => {
    setSelected(path);
    setProblem(null);
    void editor.open(path).then(setProblem);
  };

  const saved = (data: SkillSaved, destination: Destination) => {
    setSaving(false);
    setNotice(
      destination === "team"
        ? `Saved ${data.skill.slug} ${data.version.semver} to ${access.team.name}. It waits for a Team admin's review.`
        : `Saved ${data.skill.slug} ${data.version.semver} as your personal skill.`,
    );
  };

  const remove = async (e: MouseEvent<HTMLButtonElement>) => {
    const asked = { title: `Delete ${selected}?`, confirmLabel: "Delete" };
    if (!(await confirm(asked, eventTrigger(e)))) return;
    const err = await editor.removeFile(selected);
    setProblem(err);
    if (!err) setSelected(SKILL_MD);
  };

  return (
    <>
      <PageHeader
        title={draft.name}
        back={<Back />}
        description={draft.mine ? "Your draft in this team." : "A draft shared with you."}
        actions={
          <Button
            ref={saveButton}
            variant="primary"
            onClick={() => setSaving(true)}
            disabled={!canTeam && !canPersonal}
          >
            Save version
          </Button>
        }
      />
      <p className="m-0 mb-3 text-sm text-console-muted" role="status">
        {STATUS_TEXT[editor.status]}
      </p>
      {editor.status === "conflict" && (
        <Notice tone="error">
          <p>{editor.error?.message} Copy anything you want to keep, then reload.</p>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload the draft
          </Button>
        </Notice>
      )}
      {editor.status === "error" && editor.error && <ErrorNotice error={editor.error} />}
      {problem && <ErrorNotice error={problem} />}
      {notice && (
        <Notice tone="success">
          <p>{notice}</p>
        </Notice>
      )}
      {draft.mine && <DraftSettings editor={editor} teamId={teamId} confirm={confirm} />}
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[14rem_minmax(0,1fr)] 2xl:grid-cols-[14rem_minmax(0,1fr)_minmax(0,28rem)]">
        <FileTree files={files} selected={selected} onSelect={select} onAdd={editor.addFile} />
        <div className="min-w-0">
          <FilePane editor={editor} path={selected} onRemove={remove} />
          <LintPanel items={lint} />
          <ScanPanel state={scan} />
        </div>
        {/* Beside the editor on wide screens, below it otherwise (KOBE-323). */}
        <div className="min-w-0 md:col-span-2 2xl:col-span-1">
          <SkillTestPane teamId={teamId} draftId={draft.id} flush={editor.flush} />
        </div>
      </div>
      <SaveVersionDialog
        open={saving}
        onOpenChange={setSaving}
        teamId={teamId}
        teamName={access.team.name}
        draft={draft}
        canTeam={canTeam}
        canPersonal={canPersonal}
        flush={editor.flush}
        onSaved={saved}
        returnFocus={() => saveButton.current}
      />
      {confirmDialog}
    </>
  );
}

function FilePane({
  editor,
  path,
  onRemove,
}: {
  readonly editor: DraftEditor;
  readonly path: string;
  readonly onRemove: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const info = editor.files.find((f) => f.path === path);
  const text = editor.texts[path];
  if (!info) return <p>Pick a file.</p>;
  if (path === SKILL_MD && text !== undefined)
    return <SkillMdEditor key={path} text={text} onChange={(t) => editor.edit(path, t)} />;
  return (
    <>
      {info.kind === "binary" ? (
        <p className="m-0">
          {path} is a binary file ({info.size.toLocaleString()} bytes). It is kept as is.
        </p>
      ) : text === undefined ? (
        <p role="status">Loading {path}…</p>
      ) : (
        <Field label={`Contents of ${path}`}>
          <Textarea
            className="min-h-80 w-full resize-y font-mono"
            value={text}
            onChange={(e) => editor.edit(path, e.target.value)}
          />
        </Field>
      )}
      {path !== SKILL_MD && (
        <Button size="sm" variant="danger" className="mt-2" onClick={onRemove}>
          Delete {path}
        </Button>
      )}
    </>
  );
}

/** The author's controls: share with the team's Builders and Team admins, or delete the draft. */
function DraftSettings({
  editor,
  teamId,
  confirm,
}: {
  readonly editor: DraftEditor;
  readonly teamId: string;
  readonly confirm: ReturnType<typeof useConfirm>[0];
}) {
  const mutation = useMutation();
  const { draft } = editor;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Switch
        label="Share with team builders"
        hint="Builders and Team admins can see and edit it; saves still check who changed what."
        checked={draft.shared}
        disabled={mutation.pending}
        onCheckedChange={(shared) =>
          mutation.run(async () => {
            const err = await editor.share(shared);
            return err ? { ok: false, error: err } : { ok: true, status: 200, data: null };
          })
        }
      />
      <Button
        size="sm"
        variant="danger"
        onClick={async (e) => {
          const trigger = eventTrigger(e);
          if (
            !(await confirm(
              {
                title: `Delete the draft ${draft.name}?`,
                description: "Saved versions stay.",
                confirmLabel: "Delete draft",
              },
              trigger,
            ))
          )
            return;
          await mutation.run(async () => {
            const res = await deleteDraft(teamId, draft.id);
            if (res.ok) window.location.assign(WORKBENCH_HREF);
            return res;
          });
        }}
      >
        Delete draft
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </div>
  );
}
