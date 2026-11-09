/**
 * The Workspace view of projects (Workspaces FP1-FP3, CM8; KOBE-581), pure: which project a
 * scratchspace path belongs to, the member's effective role and what it lets them do with a
 * project's files, and the words the Files panel and the editor use for it.
 */
import type { Project, ProjectRole } from "./api";

/** Where projects are mounted in the scratchspace (`projects/<slug>/`; WS3 keeps the path). */
export const PROJECTS_FOLDER = "projects";

/** The slug of the project `path` is in (`projects/<slug>` or below), else undefined. */
export function projectSlugOf(path: string): string | undefined {
  const [root, slug] = path.split("/", 2);
  return root === PROJECTS_FOLDER && slug !== undefined && slug !== "" ? slug : undefined;
}

/** `projects/<slug>` itself: a mounted project's folder. */
export const isProjectFolder = (path: string): boolean =>
  projectSlugOf(path) !== undefined && path.split("/").length === 2;

/** The role the member acts with: a team admin who is not listed acts as owner (PR3). */
export const effectiveRole = (project: Pick<Project, "myRole">): ProjectRole =>
  project.myRole ?? "owner";

/** Editors and owners check out, edit and commit; readers read and converse (PR3). */
export const mayEdit = (role: ProjectRole): boolean => role !== "reader";

/** What the member may do with a project's file right now (FP3, CM8). */
export type ProjectFileAccess =
  /** Not a project path. */
  | { readonly kind: "none" }
  /** Checked out by the member: writable, with Commit… / Update / Discard. */
  | { readonly kind: "checked_out"; readonly slug: string; readonly project: Project }
  /** The member may edit but has not checked out: "Check out to edit". */
  | { readonly kind: "editable"; readonly slug: string; readonly project: Project }
  /** Read-only: a reader, an archived project, or a project not known (yet). */
  | { readonly kind: "readable"; readonly slug: string; readonly project: Project | undefined };

export function projectFileAccess(
  path: string,
  bySlug: ReadonlyMap<string, Project>,
  checkedOut: ReadonlySet<string>,
): ProjectFileAccess {
  const slug = projectSlugOf(path);
  if (slug === undefined) return { kind: "none" };
  const project = bySlug.get(slug);
  // An unknown or archived project is readable whatever checkout row exists.
  if (!project || project.archivedAt !== null) return { kind: "readable", slug, project };
  if (checkedOut.has(slug)) return { kind: "checked_out", slug, project };
  if (mayEdit(effectiveRole(project))) return { kind: "editable", slug, project };
  return { kind: "readable", slug, project };
}

/** Why files dropped onto a read-only project folder are refused (FP1). */
export function dropRefusal(access: ProjectFileAccess): string | undefined {
  if (access.kind === "editable") return `Check out to edit: ${access.project.name} is read-only.`;
  if (access.kind === "readable") return "You can read this project, not change it.";
  return undefined;
}

export const ROLE_LABELS: Readonly<Record<ProjectRole, string>> = {
  owner: "owner",
  editor: "editor",
  reader: "reader",
};

/** Why a project file opens read-only (FP3), or undefined inside the member's checkout. */
export function projectReadOnlyReason(access: ProjectFileAccess): string | undefined {
  if (access.kind === "none" || access.kind === "checked_out") return undefined;
  if (access.kind === "editable") {
    return "Project files are read-only until you check the project out.";
  }
  if (!access.project) return "Project files are read-only here.";
  if (access.project.archivedAt !== null)
    return "This project is archived: its files are read-only.";
  return "You can read this project, not change it.";
}
