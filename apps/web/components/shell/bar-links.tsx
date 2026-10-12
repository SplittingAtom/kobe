"use client";

import { command, isAvailable, type CommandId } from "../../lib/shell/commands";
import { useOpenConsoles } from "../admin/console-links";
import { IconAction } from "./icon-action";
import styles from "./shell.module.css";

const AREAS: readonly CommandId[] = ["my-memory", "my-schedules", "my-agents"];
const CONSOLES: readonly CommandId[] = ["team-console", "site-console"];

/** Bar row one, right side: the member's own areas (full pages for now; CE4 moves some beside). */
export function AreaLinks() {
  return (
    <nav aria-label="My area" className={styles.links}>
      {AREAS.map((id) => (
        <IconAction key={id} command={id} className={styles.iconLink} />
      ))}
    </nav>
  );
}

/** The consoles, role-gated by the server's answer (CE3); full-page routes (CE4). */
export function ConsoleIconLinks() {
  const consoles = useOpenConsoles();
  const open = CONSOLES.filter((id) => isAvailable(command(id), { consoles }));
  if (open.length === 0) return null;
  return (
    <nav aria-label="Administration" className={styles.links}>
      {open.map((id) => (
        <IconAction key={id} command={id} className={styles.iconLink} />
      ))}
    </nav>
  );
}
