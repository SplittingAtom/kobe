"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState, type MouseEvent } from "react";
import type { SkillSaved } from "../../lib/admin/api/team/skills";
import type { ApiError } from "../../lib/api/client";
import { deleteDraft, type Destination } from "../../lib/skills/drafts-api";
import { lintSkill } from "../../lib/skills/lint";
import type { DraftTab } from "../../lib/skills/draft-tabs";
import { SKILL_MD, splitSkillMd } from "../../lib/skills/skill-md";
import {
  Button,
  eventTrigger,
  Field,
  Notice,
  PageHeader,
  Switch,
  Textarea,
  useConfirm,
  useUnsavedChanges,
} from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { ErrorNotice, MutationStatus } from "../admin/error-notice";
import { useMutation } from "../admin/use-resource";
import { LintPanel, ScanPanel } from "./feedback";
import { FileTree } from "./file-tree";
import { NewFileEditor } from "./new-file-editor";
import { SaveVersionDialog } from "./save-version-dialog";
import { SkillMdEditor } from "./skill-md-editor";
import { EvalsPanel } from "./evals-panel";
import { SkillTestPane } from "./test-pane";
import { useDraftEditor, type DraftEditor, type SaveStatus } from "./use-draft-editor";
import { DefineLayout } from "./define-layout";
import { useSavedSkillRuns } from "./use-saved-skill-runs";
import { WorkbenchTabs } from "./workbench-tabs";
import { useNavigate } from "../shell/use-navigate";

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

/**
 * The Workbench editor of one draft (KOBE-321, SK12), in Define, Test and Eval tabs (KOBE-459);
 * `tab` is the address's `?tab=` (null: none).
 */
export function DraftEditorPage({
  draftId,
  tab = null,
}: {
  readonly draftId: string;
  readonly tab?: DraftTab | null;
}) {
  const teamId = useTeamAccess().team.id;
  const load = useDraftEditor(teamId, draftId);
  if (load.status === "ready") return <Editor editor={load.editor} tab={tab} />;
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

function Editor({ editor, tab }: { readonly editor: DraftEditor; readonly tab: DraftTab | null }) {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { draft, files, texts, scan } = editor;
  // In the Skills panel (KOBE-452), closing asks while an edit isn't written yet.
  useUnsavedChanges(editor.status !== "saved");
  const [selected, setSelected] = useState(SKILL_MD);
  const [saving, setSaving] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  // Each saved version re-reads the saved skill's eval runs (KOBE-459).
  const [savedSeq, setSavedSeq] = useState(0);
  // Create file's starting path while it is open (KOBE-478), and folders added in the tree.
  const [creating, setCreating] = useState<string | null>(null);
  const newFileDirty = useRef(false);
  const onNewFileDirty = useCallback((dirty: boolean) => {
    newFileDirty.current = dirty;
  }, []);
  const [folders, setFolders] = useState<readonly string[]>([]);

  const scripts =
    scan.status === "ready"
      ? scan.scan.scripts
      : scan.status === "idle"
        ? NO_SCRIPTS
        : (scan.last?.scripts ?? NO_SCRIPTS);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  // Folders aren't stored: one shows here until a file is saved in it.
  const emptyFolders = useMemo(
    () => folders.filter((f) => !paths.some((p) => p.startsWith(`${f}/`))),
    [folders, paths],
  );
  const skillMd = texts[SKILL_MD] ?? "";
  const lint = useMemo(() => lintSkill({ skillMd, paths, scripts }), [skillMd, paths, scripts]);
  const canTeam = access.permissions.includes("team.skills.publish");
  const canPersonal = draft.mine && access.permissions.includes("team.personal.create");

  const show = (path: string) => {
    setCreating(null);
    setSelected(path);
    setProblem(null);
  };
  /** True when nothing typed in Create file would be lost, or the author agrees to drop it. */
  const mayLeaveNewFile = async (trigger?: EventTarget | null) =>
    creating === null ||
    !newFileDirty.current ||
    confirm(
      {
        title: "Discard the new file?",
        description: "It isn't saved: what you typed will be lost.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
      },
      trigger,
    );
  const select = async (path: string) => {
    if (!(await mayLeaveNewFile())) return;
    show(path);
    void editor.open(path).then(setProblem);
  };
  const startNewFile = async (folder: string) => {
    if (!(await mayLeaveNewFile())) return;
    setCreating(folder ? `${folder}/` : "");
  };

  const saved = (data: SkillSaved, destination: Destination) => {
    setSaving(false);
    setSavedSeq((n) => n + 1);
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
      <WorkbenchTabs
        draftId={draft.id}
        requested={tab}
        flush={editor.flush}
        panels={(t, shown) =>
          t === "define" ? (
            <DefineLayout
              tree={
                <FileTree
                  files={files}
                  folders={emptyFolders}
                  selected={selected}
                  onSelect={(path) => void select(path)}
                  onAdd={editor.addFile}
                  onCreate={(folder) => void startNewFile(folder)}
                  onAddFolder={(folder) => setFolders((fs) => [...fs, folder])}
                />
              }
            >
              {creating === null ? (
                <FilePane editor={editor} path={selected} onRemove={remove} />
              ) : (
                <NewFileEditor
                  key={creating}
                  initialPath={creating}
                  paths={paths}
                  onSave={editor.addFile}
                  onSaved={show}
                  onDirtyChange={onNewFileDirty}
                  onCancel={async (e) => {
                    if (await mayLeaveNewFile(eventTrigger(e))) setCreating(null);
                  }}
                />
              )}
              <LintPanel items={lint} />
              <ScanPanel state={scan} />
            </DefineLayout>
          ) : t === "test" ? (
            <SkillTestPane teamId={teamId} draftId={draft.id} flush={editor.flush} />
          ) : (
            <EvalTab teamId={teamId} editor={editor} active={shown} refresh={savedSeq} />
          )
        }
      />
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

/** Eval: the evals panel, its history merged with the saved skill's version runs (KOBE-459). */
function EvalTab({
  teamId,
  editor,
  active,
  refresh,
}: {
  readonly teamId: string;
  readonly editor: DraftEditor;
  readonly active: boolean;
  readonly refresh: number;
}) {
  const skillMd = editor.texts[SKILL_MD] ?? "";
  const draftName = editor.draft.name;
  const name = useMemo(() => {
    const parts = splitSkillMd(skillMd);
    return parts.ok && parts.value.name ? parts.value.name : draftName;
  }, [skillMd, draftName]);
  const viewerId = useTeamAccess().user.id;
  const { saved, error } = useSavedSkillRuns({
    teamId,
    viewerId,
    name,
    mine: editor.draft.mine,
    active,
    refresh,
  });
  return (
    <>
      {error && (
        <Notice tone="warn">
          <p>The saved skill&apos;s evals can&apos;t be listed right now: {error.message}</p>
        </Notice>
      )}
      <EvalsPanel teamId={teamId} editor={editor} saved={saved} />
    </>
  );
}

export function FilePane({
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
  const navigate = useNavigate();
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
            if (res.ok) navigate(WORKBENCH_HREF);
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
