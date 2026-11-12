"use client";

import type { DiscoveryReport } from "../../../lib/admin/api/site/sso";
import { Notice } from "../../ui/console";

/**
 * What a discovery test checked (KOBE-626): tenant pinning, the SSRF guard, the document's
 * issuer, the code flow, PKCE S256 and the endpoints, each passed or failed in plain words.
 */
export function DiscoveryResult({ report }: { readonly report: DiscoveryReport }) {
  return (
    <Notice
      tone={report.ok ? "success" : "error"}
      role="status"
      title={report.ok ? "Discovery passed" : "Discovery failed"}
    >
      {report.issuer ? (
        <p className="m-0 mb-2 text-sm">
          Issuer: <code>{report.issuer}</code>
        </p>
      ) : null}
      <ul className="m-0 list-none p-0 text-sm" aria-label="Discovery checks">
        {report.checks.map((c) => (
          <li key={c.id}>
            <span aria-hidden="true">{c.ok ? "✓ " : "✗ "}</span>
            <span className="sr-only">{c.ok ? "Passed: " : "Failed: "}</span>
            {c.message}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
