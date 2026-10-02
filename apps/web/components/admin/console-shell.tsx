"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import { fetchInstallAccess, fetchTeamAccess } from "../../lib/admin/api/access";
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
import { ErrorNotice } from "./error-notice";
import { IsolationBanner } from "./isolation-banner";
import styles from "./admin.module.css";

const DEFAULT_LOADERS: Readonly<Record<ConsoleKind, () => Promise<ApiResult<ConsoleAccess>>>> = {
  install: () => fetchInstallAccess(),
  team: () => fetchTeamAccess(),
};

const DENIED: Readonly<Record<ConsoleKind, string>> = {
  install: "The install console is for the install Owner and Admins.",
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
    const retry = () => setAttempt((n) => n + 1);
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
        <main id="console-main" className={styles.main}>
          <h1>{title}</h1>
          {state.status === "loading" ? (
            <p role="status">Checking your access…</p>
          ) : (
            <ErrorNotice error={state.error} />
          )}
        </main>
      </Frame>
    );
  }

  const { access } = state;
  if (!canOpenConsole(access)) {
    // In the team console, someone who is a team admin elsewhere can switch teams from here.
    return (
      <Frame title={title} switcher={kind === "team"}>
        <main id="console-main" className={styles.main}>
          <h1>{title}</h1>
          <p role="alert" className={styles.error}>
            {DENIED[kind]} <Link href="/">Back to Kobe</Link>
          </p>
        </main>
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
      <Frame title={title} access={access}>
        <ConsoleNav kind={kind} sections={visibleSections(access)} current={section} />
        <main id="console-main" className={styles.main} tabIndex={-1} ref={main}>
          {kind === "install" && <IsolationBanner hidden={section?.id === "isolation"} />}
          {allowed ? (
            children
          ) : (
            <>
              <h1>{section.label}</h1>
              <p role="alert" className={styles.error}>
                Your role doesn&apos;t include this section.{" "}
                <Link href={consoleHref(kind)}>Back to the {title.toLowerCase()}</Link>
              </p>
            </>
          )}
        </main>
      </Frame>
    </ConsoleAccessContext.Provider>
  );
}

function Frame({
  title,
  access,
  switcher = access?.console === "team",
  children,
}: {
  readonly title: string;
  readonly access?: ConsoleAccess;
  /** Show the team switcher (team console, or when a team must be chosen first). */
  readonly switcher?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.shell} data-kobe-console="">
      <a href="#console-main" className={styles.skipLink}>
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.brandRow}>
          <p className={styles.brand}>
            <Link href="/">Kobe</Link> <span aria-hidden="true">/</span> {title}
          </p>
          {/* Top-left, as everywhere (D9). Switching reloads, so access is checked again. */}
          {switcher && <TeamSwitcher />}
        </div>
        {access && <Who access={access} />}
      </header>
      <div className={access ? styles.body : `${styles.body} ${styles.bodySingle}`}>{children}</div>
    </div>
  );
}

function Who({ access }: { readonly access: ConsoleAccess }) {
  if (access.console === "install") {
    const role = access.installRole === "owner" ? "Owner" : "Admin";
    return (
      <p className={styles.who}>
        {access.user.name} · {role}
      </p>
    );
  }
  // The team switcher beside the title already names the team and the caller's role in it.
  return <p className={styles.who}>{access.user.name}</p>;
}
