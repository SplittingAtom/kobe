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

/** Bar row one, right side: the member's own areas (full pages for now; CE4 moves some beside). */
export function AreaLinks() {
  return <Links commands={linksOf("areas", { consoles: [] })} label="My area" />;
}

/** The consoles, role-gated by the server's answer (CE3); full-page routes (CE4). */
export function ConsoleIconLinks() {
  const consoles = useOpenConsoles();
  return <Links commands={linksOf("consoles", { consoles })} label="Administration" />;
}
