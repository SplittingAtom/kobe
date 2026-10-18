"use client";

import { useEffect, useState } from "react";
import "../../app/admin/admin-global.css";
import { fetchTeamAccess } from "../../lib/admin/api/access";
import type { TeamAccess } from "../../lib/admin/nav/types";
import type { ApiError } from "../../lib/api/client";
import type { MemoryTarget } from "../../lib/memory/api";
import type { AreaId } from "../../lib/shell/areas";
import { ACTIVE_TEAM_EVENT } from "../../lib/teams";
import { ConsoleAccessContext } from "../admin/console-context";
import { ErrorNotice } from "../admin/error-notice";
import { MemoryPanel } from "../memory/memory-panel";
import { ProjectPicker } from "../projects/project-picker";
import { EmbeddedPage } from "../ui/console";
import { MyApprovalsPage } from "./my-approvals-page";
import { MyConnectorsPage } from "./my-connectors-page";
import { MySchedulesPage } from "./my-schedules-page";

/*
 * A My area page in the chat, beside the thread (CE4, KOBE-424; the frame is
 * `components/shell/area-panel.tsx`). The console sheet loads with it: its rules are scoped to
 * `data-kobe-console` (the frame carries it), so nothing else in the chat changes
 * (app/console-css-guard.test.ts).
 */

type Access =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly access: TeamAccess };

/** The member's access in the active team, as the My area shell reads it (`MyAgentsShell`). */
function useTeamAccessState(fetchFn: typeof fetch | undefined): Access {
  const [state, setState] = useState<Access>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1);
    window.addEventListener(ACTIVE_TEAM_EVENT, again);
    return () => window.removeEventListener(ACTIVE_TEAM_EVENT, again);
  }, []);
  useEffect(() => {
    let current = true;
    fetchTeamAccess(fetchFn).then(
      (res) => {
        if (current) {
          setState(
            res.ok ? { status: "ready", access: res.data } : { status: "error", error: res.error },
          );
        }
      },
      () => {
        if (current) {
          setState({
            status: "error",
            error: { status: 0, code: "client_error", message: "Could not check your access." },
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, fetchFn]);
  return state;
}

/** The member's memory, or a project's they pick (KOBE-158/164); the choice is not in the URL. */
function MemoryBeside({ teamId }: { readonly teamId: string }) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const target: MemoryTarget =
    projectId === null ? { scope: "user" } : { scope: "project", projectId };
  return (
    <>
      <ProjectPicker value={projectId} onChange={setProjectId} />
      <MemoryPanel key={projectId ?? "me"} teamId={teamId} target={target} />
    </>
  );
}

function AreaContent({ area, access }: { readonly area: AreaId; readonly access: TeamAccess }) {
  switch (area) {
    case "memory":
      return <MemoryBeside teamId={access.team.id} />;
    case "approvals":
      return <MyApprovalsPage />;
    case "schedules":
      return <MySchedulesPage />;
    case "connectors":
      return <MyConnectorsPage />;
  }
}

/** The page for `area`, once the member's access in the active team is known. */
export function AreaBeside({
  area,
  fetchFn,
}: {
  readonly area: AreaId;
  readonly fetchFn?: typeof fetch | undefined;
}) {
  const access = useTeamAccessState(fetchFn);
  if (access.status === "loading") return <p role="status">Loading…</p>;
  if (access.status === "error") return <ErrorNotice error={access.error} />;
  return (
    <ConsoleAccessContext.Provider value={access.access}>
      <EmbeddedPage.Provider value={true}>
        {/* Keyed by team: a page never carries one team's state into another's. */}
        <div key={access.access.team.id} className="flex flex-col gap-4">
          <AreaContent area={area} access={access.access} />
        </div>
      </EmbeddedPage.Provider>
    </ConsoleAccessContext.Provider>
  );
}
