"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  discardSiteDraft,
  getCatalogSkill,
  readSiteDraftText,
  type CatalogSkillView,
  type SitePublished,
} from "../../../lib/admin/api/site/catalog-edit";
import { siteDraftClient } from "../../../lib/admin/api/site/catalog-draft-client";
import type { ApiError } from "../../../lib/api/client";
import { lintSkill } from "../../../lib/skills/lint";
import { SKILL_MD } from "../../../lib/skills/skill-md";
import {
  Button,
  eventTrigger,
  Field,
  Notice,
  PageHeader,
  TextInput,
  useConfirm,
  useUnsavedChanges,
} from "../../ui/console";
import { useNavigate } from "../../shell/use-navigate";
import { DefineLayout } from "../../skills/define-layout";
import { FilePane } from "../../skills/draft-editor-page";
import { LintPanel, ScanPanel } from "../../skills/feedback";
import { FileTree } from "../../skills/file-tree";
import { NewFileEditor } from "../../skills/new-file-editor";
import { useDraftEditor, type DraftEditor, type SaveStatus } from "../../skills/use-draft-editor";
import { ErrorNotice, MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { catalogSkillHref, editBlock } from "./catalog-skill-page";
import { CatalogSaveDialog } from "./catalog-save-dialog";

const STATUS_TEXT: Readonly<Record<SaveStatus, string>> = {
  saved: "All changes saved.",
  pending: "Unsaved changes…",
  saving: "Saving…",
  error: "Your latest change isn't saved.",
  conflict: "Not saved: another Site admin changed this draft.",
};
const NO_SCRIPTS: readonly string[] = [];

/** Rename a text file: the new path is written with its text, then the old one removed. */
function RenameFile({
  skillId,
  editor,
  path,
  onRenamed,
}: {
  readonly skillId: string;
  readonly editor: DraftEditor;
  readonly path: string;
  readonly onRenamed: (path: string) => void;
}) {
  const [to, setTo] = useState(path);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const info = editor.files.find((f) => f.path === path);
  if (!info || info.kind !== "text" || path === SKILL_MD) return null;
  async function rename() {
    const next = to.trim();
    if (next === "" || next === path) return;
    // Pending edits first, so the text moved is the one saved.
    if ((await editor.flush()) === null) return;
    const text = await readSiteDraftText(skillId, path);
    if (!text.ok) return setProblem(text.error);
    const added = await editor.addFile(next, text.data);
    if (added) return setProblem(added);
    const removed = await editor.removeFile(path);
    if (removed) return setProblem(removed);
    onRenamed(next);
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void rename();
      }}
    >
      <Field label={`Rename ${path} to`}>
        <TextInput value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <Button size="sm" type="submit">
        Rename
      </Button>
      {problem && <ErrorNotice error={problem} />}
    </form>
  );
}

function Editor({
  skill,
  editor,
}: {
  readonly skill: CatalogSkillView;
  readonly editor: DraftEditor;
}) {
  const { files, texts, scan } = editor;
  useUnsavedChanges(editor.status !== "saved");
  const [selected, setSelected] = useState(SKILL_MD);
  const [saving, setSaving] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [published, setPublished] = useState<SitePublished | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [creating, setCreating] = useState<string | null>(null);
  const newFileDirty = useRef(false);
  const onNewFileDirty = useCallback((dirty: boolean) => {
    newFileDirty.current = dirty;
  }, []);
  const [folders, setFolders] = useState<readonly string[]>([]);
  const mutation = useMutation();
  const navigate = useNavigate();

  const scripts =
    scan.status === "ready"
      ? scan.scan.scripts
      : scan.status === "idle"
        ? NO_SCRIPTS
        : (scan.last?.scripts ?? NO_SCRIPTS);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const emptyFolders = useMemo(
    () => folders.filter((f) => !paths.some((p) => p.startsWith(`${f}/`))),
    [folders, paths],
  );
  const lint = useMemo(
    () => lintSkill({ skillMd: texts[SKILL_MD] ?? "", paths, scripts }),
    [texts, paths, scripts],
  );

  const show = (path: string) => {
    setCreating(null);
    setSelected(path);
    setProblem(null);
  };
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
  const remove = async (e: MouseEvent<HTMLButtonElement>) => {
    if (!(await confirm({ title: `Delete ${selected}?`, confirmLabel: "Delete" }, eventTrigger(e))))
      return;
    const err = await editor.removeFile(selected);
    setProblem(err);
    if (!err) setSelected(SKILL_MD);
  };
  const discard = async (e: MouseEvent<HTMLButtonElement>) => {
    const yes = await confirm(
      {
        title: `Discard the site draft of ${skill.name}?`,
        description: "Published versions stay. A detached Kobe skill stays detached until reset.",
        confirmLabel: "Discard draft",
      },
      eventTrigger(e),
    );
    if (!yes) return;
    await mutation.run(async () => {
      const res = await discardSiteDraft(skill.id);
      if (res.ok) navigate(catalogSkillHref(skill.id));
      return res;
    });
  };

  if (published)
    return (
      <>
        <PageHeader
          title={skill.name}
          back={<Link href={catalogSkillHref(skill.id)}>{skill.name}</Link>}
        />
        <Notice tone="success">
          <p className="m-0">
            Published {published.name} {published.semver} to the Catalog (publisher Site
            {published.previous
              ? `, after ${published.previous.semver} by ${published.previous.publisher}`
              : ""}
            ). Teams on Default get it; pinned installs stay as they are.
          </p>
        </Notice>
        <Link href={catalogSkillHref(skill.id)}>Back to {skill.name}</Link>
      </>
    );

  return (
    <>
      <PageHeader
        title={`Edit ${skill.name}`}
        back={<Link href={catalogSkillHref(skill.id)}>{skill.name}</Link>}
        description="A site draft: Site admins share it. Save version scans it and publishes it to the Catalog."
        actions={
          <Button ref={saveButton} variant="primary" onClick={() => setSaving(true)}>
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="danger" onClick={(e) => void discard(e)}>
          Discard draft
        </Button>
        <MutationStatus error={mutation.error} notice={mutation.notice} />
      </div>
      <DefineLayout
        tree={
          <FileTree
            files={files}
            folders={emptyFolders}
            selected={selected}
            onSelect={(path) => void select(path)}
            onAdd={editor.addFile}
            onCreate={(folder) => {
              void mayLeaveNewFile().then((ok) => {
                if (ok) setCreating(folder ? `${folder}/` : "");
              });
            }}
            onAddFolder={(folder) => setFolders((fs) => [...fs, folder])}
          />
        }
      >
        {creating === null ? (
          <>
            <FilePane editor={editor} path={selected} onRemove={(e) => void remove(e)} />
            <RenameFile
              key={selected}
              skillId={skill.id}
              editor={editor}
              path={selected}
              onRenamed={show}
            />
          </>
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
      <CatalogSaveDialog
        open={saving}
        onOpenChange={setSaving}
        skillId={skill.id}
        name={skill.name}
        flush={editor.flush}
        onSaved={(p) => {
          setSaving(false);
          setPublished(p);
        }}
        returnFocus={() => saveButton.current}
      />
      {confirmDialog}
    </>
  );
}

function DraftLoader({ skill }: { readonly skill: CatalogSkillView }) {
  const client = useMemo(() => siteDraftClient(skill.name), [skill.name]);
  const load = useDraftEditor("site", skill.id, client);
  if (load.status === "ready") return <Editor skill={skill} editor={load.editor} />;
  return (
    <>
      <p className="m-0 mb-1 text-sm">
        <Link href={catalogSkillHref(skill.id)}>{skill.name}</Link>
      </p>
      {load.status === "loading" ? (
        <p role="status">Loading the site draft…</p>
      ) : (
        <ErrorNotice error={load.error} />
      )}
    </>
  );
}

/**
 * The site draft of a catalog skill in the Workbench editor (KOBE-495): file tree, SKILL.md form
 * with its frontmatter checks, other files as text, add, rename and delete, lint and the live scan
 * preview; edits autosave under the draft's revision. Save version publishes it.
 */
export function CatalogSkillEditor({ skillId }: { readonly skillId: string }) {
  const { state } = useResource(() => getCatalogSkill(skillId));
  return (
    <ResourceView state={state} label="the catalog skill">
      {(skill) => {
        const blocked = editBlock(skill);
        if (blocked) return <Notice tone="warn">{blocked}</Notice>;
        if (!skill.draft)
          return (
            <Notice tone="info">
              <p className="m-0">
                {skill.name} has no site draft.{" "}
                <Link href={catalogSkillHref(skill.id)}>Pick a version to edit from.</Link>
              </p>
            </Notice>
          );
        return <DraftLoader skill={skill} />;
      }}
    </ResourceView>
  );
}
