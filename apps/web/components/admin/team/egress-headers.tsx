"use client";

import { useId, useState, type FormEvent } from "react";
import {
  clearDomainHeaders,
  setDomainHeaders,
  type InjectedHeader,
  type TeamEgressDomain,
} from "../../../lib/admin/api/team/egress";
import { Button, Field, TextInput, useConfirm, eventTrigger } from "../../ui/console";
import type { Mutation } from "../use-resource";

const MAX_HEADERS = 8;
const EMPTY: InjectedHeader = { name: "", value: "" };

/**
 * Injected headers for one enabled domain (KOBE-39, D28): names are listed; values are write-only
 * (typed here, sent once, never shown again — changing them means entering them again). Sandboxes
 * reach such a domain over `http://<domain>/…`; the egress proxy adds the headers and connects over
 * verified HTTPS.
 */
export function DomainHeaders({
  teamId,
  domain,
  mutation,
  onChanged,
}: {
  readonly teamId: string;
  readonly domain: TeamEgressDomain;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<InjectedHeader[]>([EMPTY]);
  const names = domain.headerNames;
  const [confirm, confirmDialog] = useConfirm();

  const update = (i: number, change: Partial<InjectedHeader>) =>
    setRows((all) => all.map((r, j) => (j === i ? { ...r, ...change } : r)));

  async function save(event: FormEvent) {
    event.preventDefault();
    const headers = rows.filter((r) => r.name.trim() !== "" || r.value !== "");
    const done = await mutation.run(
      () =>
        setDomainHeaders(
          teamId,
          domain.domain,
          headers.map((h) => ({ name: h.name.trim(), value: h.value })),
        ),
      () => `Saved ${headers.length} header(s) for ${domain.domain}. Values are not shown again.`,
    );
    if (done) {
      setRows([EMPTY]);
      setEditing(false);
      onChanged();
    }
  }

  async function clear(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Remove the injected headers for ${domain.domain}?`,
        confirmLabel: "Remove headers",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => clearDomainHeaders(teamId, domain.domain),
      () => `Removed the injected headers for ${domain.domain}.`,
    );
    if (done) onChanged();
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {names.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {names.map((n) => (
              <code key={n}>{n} </code>
            ))}
          </span>
        ) : (
          <span className="text-sm text-console-muted">None</span>
        )}
        <Button size="sm" disabled={mutation.pending} onClick={() => setEditing(true)}>
          {names.length > 0 ? "Replace" : "Add"} headers
          <span className="sr-only"> for {domain.domain}</span>
        </Button>
        {names.length > 0 ? (
          <Button
            size="sm"
            variant="danger"
            disabled={mutation.pending}
            onClick={(e) => void clear(eventTrigger(e))}
          >
            Remove headers<span className="sr-only"> for {domain.domain}</span>
          </Button>
        ) : null}
        {confirmDialog}
      </div>
    );
  }

  return (
    <form
      className="my-2 grid gap-3"
      aria-label={`Headers for ${domain.domain}`}
      onSubmit={(e) => void save(e)}
    >
      <p className="m-0 text-sm text-console-muted">
        Sent by the egress proxy with every request the team&apos;s sandboxes make to{" "}
        <code>http://{domain.domain}/…</code> (upgraded to verified HTTPS). Values are stored
        encrypted and never shown again; saving replaces all headers for this domain.
      </p>
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3">
          <Field id={`${ids}-n${i}`} label="Header name">
            <TextInput
              value={row.name}
              autoComplete="off"
              onChange={(e) => update(i, { name: e.target.value })}
            />
          </Field>
          <Field id={`${ids}-v${i}`} label="Value">
            <TextInput
              type="password"
              value={row.value}
              autoComplete="new-password"
              onChange={(e) => update(i, { value: e.target.value })}
            />
          </Field>
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5">
        {rows.length < MAX_HEADERS ? (
          <Button size="sm" onClick={() => setRows((all) => [...all, EMPTY])}>
            Another header
          </Button>
        ) : null}
        <Button size="sm" type="submit" variant="primary" disabled={mutation.pending}>
          Save headers
        </Button>
        <Button size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
