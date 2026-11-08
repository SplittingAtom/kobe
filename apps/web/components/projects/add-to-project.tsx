"use client";

/**
 * Add to project (KOBE-585, workspaces lane WS-2): the owner of an artifact or a workspace file
 * copies it into a project, where every member finds it read-only under `projects/<slug>/`. The
 * action sits on the artifact header, the file tab header and file cards, for the content's owner
 * only (readers never see it: absent, not disabled). The dialog asks for the project (those the
 * caller may add to), a folder (the project's existing folders, root by default) and the name
 * (prefilled). The server copies the bytes it stored and decides again; a same-name file answers
 * 409 `already_exists`, and "Add as copy" sends the first `-2`, `-3` … free in the project's file
 * list (another try only if someone took that name meanwhile).
 */
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { UPLOAD_FILE_NAME_MAX } from "@kobe/protocol";
import {
  addableProjects,
  firstFreeName,
  mountedPath,
  projectFolders,
} from "../../lib/projects/add-to-project";
import {
  createProjectsApi,
  describeProjectError,
  type ImportSource,
  type Project,
  type ProjectFile,
  type ProjectsApi,
} from "../../lib/projects/api";
import { joinPath } from "../../lib/files/tree";
import { useResource } from "../admin/use-resource";
import { useChatSession } from "../chat/kobe-runtime";
import { IconAction } from "../shell/icon-action";

const BUTTON = "rounded-md border px-2 py-0.5 text-xs";
const FIELD = "border-input bg-background rounded-md border px-1.5 py-0.5 text-xs";
/** Races "Add as copy" survives (someone else took the free name between list and add). */
const COPY_RACES = 3;

type Phase =
  | { readonly kind: "editing" }
  | { readonly kind: "busy" }
  | { readonly kind: "exists"; readonly name: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "done"; readonly project: Project; readonly path: string };

interface TargetProps {
  readonly api: ProjectsApi;
  readonly source: ImportSource;
  readonly project: Project;
  readonly name: string;
  onName(name: string): void;
  onDone(project: Project, path: string): void;
  onClose(): void;
}

/** Folder, name and the add itself for one project (keyed by it: its file list loads once). */
function ProjectTarget({ api, source, project, name, onName, onDone, onClose }: TargetProps) {
  const id = useId();
  const { state: files } = useResource(() => api.files(project.id));
  const listed: readonly ProjectFile[] = files.status === "ready" ? files.data : [];
  const folders = useMemo(() => projectFolders(listed), [listed]);
  const [folder, setFolder] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const send = (candidate: string) =>
    api.importFile(project.id, { source, folder, name: candidate });
  const done = (path: string) => onDone(project, mountedPath(project.slug, path));
  const fail = (error: Parameters<typeof describeProjectError>[0]) =>
    setPhase({ kind: "error", message: describeProjectError(error) });

  const add = async () => {
    const wanted = name.trim();
    setPhase({ kind: "busy" });
    const res = await send(wanted);
    if (res.ok) done(res.data.path);
    else if (res.error.code === "already_exists") setPhase({ kind: "exists", name: wanted });
    else fail(res.error);
  };
  const addCopy = async () => {
    const wanted = name.trim();
    const taken = new Set([...listed.map((f) => f.path), joinPath(folder, wanted)]);
    setPhase({ kind: "busy" });
    for (let race = 0; race < COPY_RACES; race += 1) {
      const candidate = firstFreeName(wanted, folder, taken);
      if (candidate === undefined) break;
      const res = await send(candidate);
      if (res.ok) return done(res.data.path);
      if (res.error.code !== "already_exists") return fail(res.error);
      taken.add(joinPath(folder, candidate));
    }
    setPhase({ kind: "exists", name: wanted });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() !== "") void add();
  };

  return (
    <form className="flex flex-col gap-1.5" onSubmit={submit}>
      <label htmlFor={`${id}-f`}>Folder</label>
      <select
        id={`${id}-f`}
        className={FIELD}
        value={folder}
        onChange={(e) => {
          setFolder(e.target.value);
          setPhase({ kind: "editing" });
        }}
      >
        <option value="">Top level</option>
        {folders.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-n`}>Name</label>
      <input
        id={`${id}-n`}
        className={FIELD}
        value={name}
        maxLength={UPLOAD_FILE_NAME_MAX}
        onChange={(e) => {
          onName(e.target.value);
          setPhase({ kind: "editing" });
        }}
      />
      {phase.kind === "exists" && (
        <p role="alert" className="m-0">
          {`${project.name} already has a file named ${phase.name} there.`}
        </p>
      )}
      {phase.kind === "error" && (
        <p role="alert" className="text-destructive m-0">
          {phase.message}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <button type="button" className={BUTTON} onClick={onClose}>
          Cancel
        </button>
        {phase.kind === "exists" ? (
          <button type="button" className={BUTTON} onClick={() => void addCopy()}>
            Add as copy
          </button>
        ) : (
          <button
            type="submit"
            className={BUTTON}
            disabled={phase.kind === "busy" || name.trim() === ""}
          >
            {phase.kind === "busy" ? "Adding…" : "Add"}
          </button>
        )}
      </div>
    </form>
  );
}

export function AddToProjectDialog({
  api,
  source,
  defaultName,
  onClose,
}: {
  readonly api: ProjectsApi;
  readonly source: ImportSource;
  readonly defaultName: string;
  onClose(): void;
}) {
  const id = useId();
  const first = useRef<HTMLSelectElement>(null);
  const { state: projects } = useResource(() => api.list(false));
  const list = useMemo(
    () => (projects.status === "ready" ? addableProjects(projects.data) : []),
    [projects],
  );
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const project = list.find((p) => p.id === projectId) ?? list[0];
  const [name, setName] = useState(defaultName);
  const [added, setAdded] = useState<{ project: Project; path: string } | null>(null);
  useEffect(() => first.current?.focus(), [projects.status]);

  return (
    <div
      role="dialog"
      aria-labelledby={`${id}-t`}
      className="bg-background border-border absolute top-full right-0 z-30 mt-1 flex w-72 flex-col gap-1.5 rounded-md border p-2 text-xs shadow-md"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <p id={`${id}-t`} className="m-0 font-medium">
        Add to project
      </p>
      {projects.status === "loading" && <p role="status">Loading your projects…</p>}
      {projects.status === "error" && <p role="alert">{describeProjectError(projects.error)}</p>}
      {projects.status === "ready" && list.length === 0 && (
        <p role="status">You are not in a project that takes files.</p>
      )}
      {added ? (
        <div role="status" className="flex flex-col gap-1">
          <p className="m-0">{`Added to ${added.project.name} as ${added.path}`}</p>
          <Link className="underline" href={`/me/projects/${added.project.id}`}>
            Open the project&apos;s files
          </Link>
          <button type="button" className={`${BUTTON} self-end`} onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        project && (
          <>
            <label htmlFor={`${id}-p`}>Project</label>
            <select
              ref={first}
              id={`${id}-p`}
              className={FIELD}
              value={project.id}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ProjectTarget
              key={project.id}
              api={api}
              source={source}
              project={project}
              name={name}
              onName={setName}
              onDone={(p, path) => setAdded({ project: p, path })}
              onClose={onClose}
            />
          </>
        )
      )}
    </div>
  );
}

/**
 * The action and its dialog. Callers render it for the content's owner only; `api` is for tests
 * (the page's own projects API otherwise).
 */
export function AddToProject({
  source,
  defaultName,
  size,
  api,
}: {
  readonly source: ImportSource;
  readonly defaultName: string;
  readonly size?: "sm" | "md" | undefined;
  readonly api?: ProjectsApi | undefined;
}) {
  const session = useChatSession();
  const projectsApi = useMemo(() => api ?? createProjectsApi(session.teamId), [api, session]);
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <IconAction
        command="add-to-project"
        label={`Add ${defaultName} to a project`}
        size={size}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <AddToProjectDialog
          api={projectsApi}
          source={source}
          defaultName={defaultName}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
