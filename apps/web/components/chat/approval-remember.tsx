"use client";

import { useId } from "react";
import type { RememberScope } from "@kobe/protocol";
import type { RememberOptions } from "../../lib/chat/types";
import { visible } from "../../lib/security/visible";
import styles from "./chat.module.css";

/** What the member picked; `remember: false` sends no rule. */
export interface RememberChoice {
  readonly remember: boolean;
  readonly scope: RememberScope | undefined;
  readonly exact: boolean;
}

function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How long the chosen rule holds, in words, from the server's own expiry. */
function lifetime(scope: RememberScope, expiresAt: string | null, timeZone: string): string {
  const until = expiresAt === null ? null : whenText(expiresAt);
  if (scope === "thread") {
    return until
      ? `Ends with this conversation, at the latest ${until}.`
      : "Ends with this conversation.";
  }
  if (scope === "run")
    return until ? `Ends with this run, at the latest ${until}.` : "Ends with this run.";
  if (scope === "today") return `Ends at midnight (${timeZone}): ${until ?? ""}.`;
  if (scope === "forever")
    return until ? `Ends ${until}.` : "Until you revoke it in My area, Approvals.";
  return until ? `Ends ${until}.` : "";
}

/**
 * The approval card's "remember" controls (KOBE-289): only the choices the server says the team's
 * limits allow for this tool, each with the expiry the server would set, and "only this exact
 * action" with the exact pattern shown before it is saved. The server checks all of it again.
 */
export function RememberControls({
  options,
  toolShown,
  value,
  onChange,
  disabled,
}: {
  readonly options: RememberOptions;
  readonly toolShown: string;
  readonly value: RememberChoice;
  readonly onChange: (next: RememberChoice) => void;
  readonly disabled: boolean;
}) {
  const ids = useId();
  if (!options.canRemember || options.choices.length === 0) {
    return options.reason ? <p className={styles.hint}>{options.reason}</p> : null;
  }
  const scope = value.scope ?? options.choices[0]?.scope;
  const picked = options.choices.find((c) => c.scope === scope) ?? options.choices[0];
  const exactForced = options.exactOnly;
  const exact = exactForced || value.exact;
  const set = (next: Partial<RememberChoice>) => onChange({ ...value, scope, ...next });
  return (
    <div className={styles.approvalRemember}>
      <label>
        <input
          type="checkbox"
          checked={value.remember}
          onChange={(e) => set({ remember: e.target.checked })}
          disabled={disabled}
        />{" "}
        Remember: allow <span className={styles.toolName}>{toolShown}</span>
      </label>{" "}
      <select
        aria-label="Remember for"
        value={scope}
        onChange={(e) => set({ scope: e.target.value as RememberScope })}
        disabled={disabled || !value.remember}
      >
        {options.choices.map((c) => (
          <option key={c.scope} value={c.scope}>
            {c.label}
          </option>
        ))}
      </select>
      {value.remember && picked && (
        <p className={styles.hint} id={`${ids}-life`}>
          {lifetime(picked.scope, picked.expiresAt, options.timeZone)}
        </p>
      )}
      {options.exact !== null && (
        <label className={styles.hint}>
          <input
            type="checkbox"
            checked={exact}
            onChange={(e) => set({ exact: e.target.checked })}
            disabled={disabled || !value.remember || exactForced}
          />{" "}
          Only this exact action{exactForced ? " (your team allows only this)" : ""}
        </label>
      )}
      {value.remember && exact && options.exact !== null && (
        <ul className={styles.approvalReasons} aria-label="Exact action to remember">
          {Object.entries(options.exact.argPattern).map(([pointer, glob]) => (
            <li key={pointer}>
              <code>{visible(pointer)}</code> is exactly <code>{visible(unescapeGlob(glob))}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The literal text a server-derived exact glob matches (it escapes only `*`, `?` and `\`). */
export function unescapeGlob(glob: string): string {
  return glob.replace(/\\([\\*?])/g, "$1");
}
