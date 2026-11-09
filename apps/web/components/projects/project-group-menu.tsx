"use client";

/**
 * The Threads panel's project header menu (Workspaces FP4; KOBE-581): Check out / Commit… for
 * editors and owners (Commit… while checked out; Update and Discard too), and Open project page
 * for everyone who can see it. The outcome shows under the header.
 */
import { useEffect, useState } from "react";
import type { MenuBindings } from "../../lib/shell/menu";
import { effectiveRole, mayEdit } from "../../lib/projects/workspace";
import { ActionMenu, ROW_REVEAL } from "../ui/action-menu";
import { useNavigate } from "../shell/use-navigate";
import { ProjectWorkPanel, type ProjectRef, type WorkAction } from "./project-work";
import { useWorkspaceProjects } from "./workspace-projects";

export function useProjectGroupMenu(projectId: string | undefined) {
  const ctx = useWorkspaceProjects();
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ ref: ProjectRef; action: WorkAction } | null>(null);
  const ensure = ctx?.ensure;
  useEffect(() => {
    if (projectId !== undefined) ensure?.();
  }, [projectId, ensure]);
  if (!ctx || projectId === undefined || ctx.status !== "ready") return null;
  const project = [...ctx.bySlug.values()].find((p) => p.id === projectId);
  if (!project) return null;
  const ref = { id: project.id, name: project.name };
  const act = (action: WorkAction) => ({
    onSelect: () => setOpen({ ref, action }),
    movesFocus: true,
  });
  const editable = project.archivedAt === null && mayEdit(effectiveRole(project));
  const checkedOut = ctx.checkedOut.has(project.slug);
  const bindings: MenuBindings = {
    ...(editable && !checkedOut
      ? { "checkout-project": { ...act("checkout"), label: "Check out" } }
      : {}),
    ...(editable && checkedOut
      ? {
          "commit-project": act("commit"),
          "update-project": act("update"),
          "discard-project": { ...act("discard"), destructive: true },
        }
      : {}),
    "open-project-page": { onSelect: () => navigate(`/me/projects/${project.id}`) },
  };
  return {
    menu: (
      <ActionMenu
        trigger="file-row-actions"
        label={`Actions for project ${project.name}`}
        scope="file-menu"
        size="sm"
        className={ROW_REVEAL}
        bindings={bindings}
      />
    ),
    panel: open && (
      <ProjectWorkPanel
        key={`${open.ref.id}:${open.action}`}
        project={open.ref}
        action={open.action}
        onClose={() => setOpen(null)}
      />
    ),
  };
}
