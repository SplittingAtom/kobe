"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import { fetchSiteAccess, fetchTeamAccess } from "../../lib/admin/api/access";
import {
  CONSOLE_TITLES,
  canOpenConsole,
  canSee,
  consoleHref,
  sectionForPath,
  visibleSections,
} from "../../lib/admin/nav/registry";
import type { ConsoleAccess, ConsoleKind } from "../../lib/admin/nav/types";
import { TeamSwitcher } from "../../app/team-switcher";
import { ACTIVE_TEAM_EVENT } from "../../lib/teams";
import { ConsoleAccessContext } from "./console-context";
import { ConsoleNav } from "./console-nav";
import { ConsoleThemeToggle } from "./console-theme-toggle";
import { ErrorNotice } from "./error-notice";
import { IsolationBanner } from "./isolation-banner";
import { ChatReturnLink } from "../shell/chat-return-link";
import {
  ConsoleLayout,
  ConsoleMain,
  ConsoleWho,
  Notice,
  PageHeader,
  useInPanel,
} from "../ui/console";

const DEFAULT_LOADERS: Readonly<Record<ConsoleKind, () => Promise<ApiResult<ConsoleAccess>>>> = {
  site: () => fetchSiteAccess(),
  team: () => fetchTeamAccess(),
};

const DENIED: Readonly<Record<ConsoleKind, string>> = {
  site: "The site console is for the site Owner and Admins.",
  team: "The team console is for team admins of the active team.",
};

type AccessState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly access: ConsoleAccess };

/**
 * The shell of both admin consoles. It asks the server who the caller is before rendering any
 * page, and renders no page (so no page fetches anything) unless the caller's role covers the
 * section. This is a courtesy, not the authorization: each page's API checks the same rule.
 */
export function ConsoleShell({
  kind,
  pathname,
  children,
  loadAccess = DEFAULT_LOADERS[kind],
}: {
  readonly kind: ConsoleKind;
  readonly pathname: string;
  readonly children: ReactNode;
  readonly loadAccess?: () => Promise<ApiResult<ConsoleAccess>>;
}) {
  const [state, setState] = useState<AccessState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // A fresh session has no active team until the switcher picks one: check again when it does.
  useEffect(() => {
    const retry = () => {
      // Nothing from the old answer stays on screen while we ask again.
      setState({ status: "loading" });
      setAttempt((n) => n + 1);
    };
    window.addEventListener(ACTIVE_TEAM_EVENT, retry);
    return () => window.removeEventListener(ACTIVE_TEAM_EVENT, retry);
  }, []);

  useEffect(() => {
    let current = true;
    loadAccess().then(
      (res) => {
        if (!current) return;
        setState(
          res.ok ? { status: "ready", access: res.data } : { status: "error", error: res.error },
        );
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
  }, [loadAccess, attempt]);

  const title = CONSOLE_TITLES[kind];
  if (state.status !== "ready") {
    const needsTeam = state.status === "error" && state.error.code === "no_active_team";
    return (
      <Frame title={title} switcher={kind === "team" && needsTeam}>
        <ConsoleMain>
          <PageHeader title={title} />
          {state.status === "loading" ? (
            <p role="status">Checking your access…</p>
          ) : (
            <ErrorNotice error={state.error} />
          )}
        </ConsoleMain>
      </Frame>
    );
  }

  const { access } = state;
  if (!canOpenConsole(access)) {
    // In the team console, someone who is a team admin elsewhere can switch teams from here.
    return (
      <Frame title={title} switcher={kind === "team"}>
        <ConsoleMain>
          <PageHeader title={title} />
          <Notice tone="error">
            {DENIED[kind]} <ChatReturnLink>Back to Kobe</ChatReturnLink>
          </Notice>
        </ConsoleMain>
      </Frame>
    );
  }

  return (
    <Console kind={kind} access={access} pathname={pathname} title={title}>
      {children}
    </Console>
  );
}

/** The open console: navigation, the current section, focus moved to it on navigation. */
function Console({
  kind,
  access,
  pathname,
  title,
  children,
}: {
  readonly kind: ConsoleKind;
  readonly access: ConsoleAccess;
  readonly pathname: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const main = useRef<HTMLElement>(null);
  const firstPath = useRef(pathname);
  useEffect(() => {
    // After client navigation, start screen readers and keyboards at the new section.
    if (pathname !== firstPath.current) main.current?.focus();
  }, [pathname]);
  const section = sectionForPath(kind, pathname);
  const allowed = section === null || canSee(section, access);
  return (
    <ConsoleAccessContext.Provider value={access}>
      <Frame
        title={title}
        access={access}
        nav={<ConsoleNav kind={kind} sections={visibleSections(access)} current={section} />}
      >
        <ConsoleMain tabIndex={-1} ref={main}>
          {kind === "site" && <IsolationBanner hidden={section?.id === "isolation"} />}
          {allowed ? (
            // Keyed by team: a page never carries one team's state into another's.
            <Fragment key={access.console === "team" ? access.team.id : "site"}>
              {children}
            </Fragment>
          ) : (
            <>
              <PageHeader title={section.label} />
              <Notice tone="error">
                Your role doesn&apos;t include this section.{" "}
                <Link href={consoleHref(kind)}>Back to the {title.toLowerCase()}</Link>
              </Notice>
            </>
          )}
        </ConsoleMain>
      </Frame>
    </ConsoleAccessContext.Provider>
  );
}

function Frame({
  title,
  access,
  switcher = access?.console === "team",
  nav,
  children,
}: {
  readonly title: string;
  readonly access?: ConsoleAccess;
  /** Show the team switcher (team console, or when a team must be chosen first). */
  readonly switcher?: boolean;
  readonly nav?: ReactNode;
  readonly children: ReactNode;
}) {
  // Over the workspace (KOBE-452) the panel's header names the console and closes it.
  const panel = useInPanel();
  return (
    <ConsoleLayout
      panel={panel}
      brand={
        <>
          <ChatReturnLink>Kobe</ChatReturnLink> <span aria-hidden="true">/</span> {title}
        </>
      }
      // Top-left, as everywhere (D9). Switching reloads, so access is checked again.
      headerStart={switcher && <TeamSwitcher />}
      headerEnd={
        <>
          {access && <Who access={access} />}
          <ConsoleThemeToggle />
        </>
      }
      nav={nav}
    >
      {children}
    </ConsoleLayout>
  );
}

function Who({ access }: { readonly access: ConsoleAccess }) {
  if (access.console === "site") {
    const role = access.siteRole === "owner" ? "Owner" : "Admin";
    return (
      <ConsoleWho>
        {access.user.name} · {role}
      </ConsoleWho>
    );
  }
  // The team switcher beside the title already names the team and the caller's role in it.
  return <ConsoleWho>{access.user.name}</ConsoleWho>;
}
