"use client";

import type { LintItem } from "../../lib/skills/lint";
import type { ScanPreview } from "../../lib/skills/drafts-api";
import { Badge, Section, type BadgeTone } from "../ui/console";
import type { ScanState } from "./use-draft-editor";

/** Lint (SK12), recomputed on every keystroke: errors first, each naming its file. */
export function LintPanel({ items }: { readonly items: readonly LintItem[] }) {
  const errors = items.filter((i) => i.level === "error");
  const warnings = items.filter((i) => i.level === "warning");
  return (
    <Section title="Lint" level={3}>
      <p className="m-0 mb-2 text-sm" aria-live="polite">
        {items.length === 0
          ? "No problems found."
          : `${errors.length} ${errors.length === 1 ? "error" : "errors"}, ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}.`}
      </p>
      {items.length > 0 && (
        <ul className="m-0 grid gap-1 ps-5">
          {[...errors, ...warnings].map((i) => (
            <li key={`${i.id}:${i.file ?? ""}:${i.message}`}>
              <Badge tone={i.level === "error" ? "failed" : "attention"} className="me-2">
                {i.level === "error" ? "Error" : "Warning"}
              </Badge>
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const VERDICT: Readonly<
  Record<ScanPreview["verdict"], { label: string; tone: BadgeTone; note: string }>
> = {
  pass: { label: "Pass", tone: "done", note: "Nothing the scanner flags." },
  caution: {
    label: "Caution",
    tone: "attention",
    note: "A reviewer must acknowledge these findings before the team can use a version.",
  },
  block: {
    label: "Block",
    tone: "failed",
    note: "A version with these findings is blocked unless a Site admin overrides it.",
  },
};

function Findings({ scan }: { readonly scan: ScanPreview }) {
  const v = VERDICT[scan.verdict];
  return (
    <>
      <p className="m-0 mb-2">
        <Badge tone={v.tone}>{v.label}</Badge> <span className="text-sm">{v.note}</span>
      </p>
      {scan.findings.length > 0 && (
        <ul className="m-0 grid gap-1 ps-5 text-sm">
          {scan.findings.map((f, n) => (
            <li key={`${f.file}:${f.line}:${f.rule}:${n}`}>
              <span className="font-medium">{f.severity === "block" ? "Block" : "Caution"}</span>{" "}
              {f.category} ({f.rule}) in {f.file || "the package"}
              {f.line > 0 ? `, line ${f.line}` : ""}
              {f.excerpt && <code className="ms-1 break-all">{f.excerpt}</code>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The live scan preview (SK12, SK32): the verdict tier of the draft as last saved. */
export function ScanPanel({ state }: { readonly state: ScanState }) {
  const shown = state.status === "ready" ? state.scan : state.status === "idle" ? null : state.last;
  return (
    <Section title="Scan preview" level={3}>
      <p className="m-0 mb-2 text-sm text-console-muted" role="status">
        {state.status === "running"
          ? "Scanning your latest change…"
          : state.status === "busy" || state.status === "error"
            ? state.message
            : shown
              ? `Scanned as saved (revision ${shown.rev}).`
              : "Not scanned yet."}
      </p>
      {shown && <Findings scan={shown} />}
    </Section>
  );
}
