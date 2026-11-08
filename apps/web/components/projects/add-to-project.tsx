"use client";

/**
 * Add to project (KOBE-585, workspaces lane WS-2): the owner of an artifact or a workspace file
 * copies it into a project, where every member finds it read-only under `projects/<slug>/`. The
 * action sits on the artifact header, the file tab header and file cards, for the content's owner
 * only (readers never see it: absent, not disabled). The dialog asks for the project (those the
 * caller may add to), a folder (the project's existing folders, root by default) and the name
 * (prefilled). The server copies the bytes it stored and decides again; a same-name file answers
 * `file_exists`, and "Add as copy" retries with `-2`, `-3` ….
 */
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  addableProjects,
  mountedPath,
  numberedName,
  projectFolders,
} from "../../lib/projects/add-to-project";
import {
  createProjectsApi,
  describeProjectError,
  type ImportSource,
  type Project,
  type ProjectsApi,
} from "../../lib/projects/api";
import { useChatSession } from "../chat/kobe-runtime";
import { IconAction } from "../shell/icon-action";

const BUTTON = "rounded-md border px-2 py-0.5 text-xs";
const FIELD = "border-input bg-background rounded-md border px-1.5 py-0.5 text-xs";
/** "Add as copy" stops after this many numbered names. */
const COPY_TRIES = 50;

type Phase =
  | { readonly kind: "editing" }
  | { readonly kind: "busy" }
  | { readonly kind: "exists"; readonly name: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "done"; readonly project: Project; readonly path: string };

type Load<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly message: string };

function useProjects(api: ProjectsApi): Load<Project[]> {
  const [state, setState] = useState<Load<Project[]>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    void api.list(false).then((res) => {
      if (!live) return;
      setState(
        res.ok
          ? { status: "ready", data: addableProjects(res.data) }
          : { status: "error", message: describeProjectError(res.error) },
      );
    });
    return () => {
      live = false;
    };
  }, [api]);
  return state;
}

function useFolders(api: ProjectsApi, projectId: string | undefined): readonly string[] {
  const [folders, setFolders] = useState<readonly string[]>([]);
  useEffect(() => {
    setFolders([]);
    if (projectId === undefined) return;
    let live = true;
    void api.files(projectId).then((res) => {
      // Without the list, root is still offered.
      if (live && res.ok) setFolders(projectFolders(res.data));
    });
    return () => {
      live = false;
    };
  }, [api, projectId]);
  return folders;
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
  const projects = useProjects(api);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const list = projects.status === "ready" ? projects.data : [];
  const project = list.find((p) => p.id === projectId) ?? list[0];
  const folders = useFolders(api, project?.id);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState(defaultName);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  useEffect(() => first.current?.focus(), [projects.status]);

  const add = async (target: Project, names: readonly string[]) => {
    setPhase({ kind: "busy" });
    for (const candidate of names) {
      const res = await api.importFile(target.id, { source, folder, name: candidate });
      if (res.ok) {
        setPhase({ kind: "done", project: target, path: mountedPath(target.slug, res.data.path) });
        return;
      }
      if (res.error.code !== "file_exists") {
        setPhase({ kind: "error", message: describeProjectError(res.error) });
        return;
      }
    }
    setPhase({ kind: "exists", name: names[0] ?? name });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (project && name.trim() !== "") void add(project, [name.trim()]);
  };
  const copies = useMemo(
    () => Array.from({ length: COPY_TRIES }, (_, i) => numberedName(name.trim(), i + 2)),
    [name],
  );

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
      {projects.status === "error" && <p role="alert">{projects.message}</p>}
      {projects.status === "ready" && list.length === 0 && (
        <p role="status">You are not in a project that takes files.</p>
      )}
      {phase.kind === "done" ? (
        <div role="status" className="flex flex-col gap-1">
          <p className="m-0">{`Added to ${phase.project.name} as ${phase.path}`}</p>
          <Link className="underline" href={`/me/projects/${phase.project.id}`}>
            Open the project&apos;s files
          </Link>
          <button type="button" className={`${BUTTON} self-end`} onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        project && (
          <form className="flex flex-col gap-1.5" onSubmit={submit}>
            <label htmlFor={`${id}-p`}>Project</label>
            <select
              ref={first}
              id={`${id}-p`}
              className={FIELD}
              value={project.id}
              onChange={(e) => {
                setProjectId(e.target.value);
                setFolder("");
                setPhase({ kind: "editing" });
              }}
            >
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label htmlFor={`${id}-f`}>Folder</label>
            <select
              id={`${id}-f`}
              className={FIELD}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
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
              maxLength={255}
              onChange={(e) => {
                setName(e.target.value);
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
                <button type="button" className={BUTTON} onClick={() => void add(project, copies)}>
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
