"use client";

import type { Connector } from "../../../lib/admin/api/site/connectors";
import { Badge } from "../../ui/console";
import { DateTime } from "../parts";

/**
 * The periodic refresh could not check the connector for changed tools (KOBE-431). For
 * `auth_required`, says whose key Kobe would use, so an admin knows how to fix it.
 */
/** Why the templates were not checked, in words (KOBE-433). */
const TEMPLATE_SKIPS: Readonly<Record<string, string>> = {
  proxy_outdated:
    "Kobe's MCP proxy is older than this server and cannot read app templates. Upgrade the proxy.",
  write_failed: "Kobe could not store the server's app templates.",
};

/**
 * The refresh checked the tools but not the MCP Apps templates (KOBE-433): only approved
 * templates are shown meanwhile, and changes upstream are not noticed.
 */
function TemplatesSkipped({ reason }: { readonly reason: string }) {
  return (
    <p className="m-0 mt-1 text-sm text-console-muted">
      <Badge tone="attention">App templates not checked for changes</Badge>{" "}
      {TEMPLATE_SKIPS[reason] ??
        `The server's app templates could not be read (${reason.replaceAll("_", " ")}).`}
    </p>
  );
}

export function RefreshSkipped({ connector: c }: { readonly connector: Connector }) {
  if (c.refreshSkipped === null) {
    return c.templatesSkipped ? <TemplatesSkipped reason={c.templatesSkipped} /> : null;
  }
  const auth = c.refreshSkipped === "auth_required";
  return (
    <p className="m-0 mt-1 text-sm text-console-muted">
      <Badge tone="attention">
        {auth ? "Not checked for changes: needs a key" : "Last check for changes failed"}
      </Badge>{" "}
      {auth
        ? c.credentialSource === "site"
          ? "Kobe checks it with its site-wide key, which is not set or must be re-entered. Set the site-wide key."
          : "Kobe checks it with the own key of the site admin who last pinned or approved its tools. Add your key for it at My connector keys, then pin or approve its tools."
        : `The server could not be checked (${c.refreshSkipped.replaceAll("_", " ")}).`}
      {c.refreshedAt ? (
        <>
          {" "}
          Last tried <DateTime value={c.refreshedAt} />.
        </>
      ) : null}
    </p>
  );
}
