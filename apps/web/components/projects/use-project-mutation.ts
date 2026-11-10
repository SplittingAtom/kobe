"use client";

import { useMemo } from "react";
import { useMutation } from "../admin/use-resource";
import { useWorkspaceProjects } from "./workspace-projects";

/**
 * `useMutation` for the project pages (KOBE-590, FP6): after a change is saved (a project created,
 * archived or edited, a member added or removed) the Files panel's project list reads again. Without
 * the chat's provider (pages outside it) it is `useMutation` as it was.
 */
export function useProjectMutation(): ReturnType<typeof useMutation> {
  const mutation = useMutation();
  const reload = useWorkspaceProjects()?.reload;
  const { run } = mutation;
  return useMemo(
    () => ({
      ...mutation,
      run: (async (change, onSuccess) => {
        const done = await run(change, onSuccess);
        if (done) reload?.();
        return done;
      }) as typeof run,
    }),
    [mutation, run, reload],
  );
}
