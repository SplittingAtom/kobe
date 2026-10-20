"use client";

import {
  commandsIn,
  type Command,
  type CommandContext,
  type RegisteredCommand,
} from "../../lib/shell/commands";
import { useOpenConsoles } from "../admin/console-links";
import { IconAction } from "./icon-action";
import styles from "./shell.module.css";

/** The bar's link icons of one registry group available in `ctx`. */
function linksOf(
  group: NonNullable<Command["group"]>,
  ctx: CommandContext,
): readonly RegisteredCommand[] {
  return commandsIn("bar", ctx).filter((c) => c.group === group);
}

function Links({
  commands,
  label,
}: {
  readonly commands: readonly RegisteredCommand[];
  readonly label: string;
}) {
  if (commands.length === 0) return null;
  return (
    <nav aria-label={label} className={styles.links}>
      {commands.map((c) => (
        <IconAction key={c.id} command={c.id} className={styles.iconLink} />
      ))}
    </nav>
  );
}

/**
 * The bar's right side: the member's own areas (My memory, My schedules, My agents, Skills), each
 * a panel over the workspace (KOBE-452).
 */
export function AreaLinks() {
  return <Links commands={linksOf("areas", { consoles: [] })} label="My area" />;
}

/** The consoles, role-gated by the server's answer (CE3); panels over the workspace (KOBE-452). */
export function ConsoleIconLinks() {
  const consoles = useOpenConsoles();
  return <Links commands={linksOf("consoles", { consoles })} label="Administration" />;
}
