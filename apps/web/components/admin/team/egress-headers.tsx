"use client";

import { useId, useState, type FormEvent } from "react";
import {
  clearDomainHeaders,
  setDomainHeaders,
  type InjectedHeader,
  type TeamEgressDomain,
} from "../../../lib/admin/api/team/egress";
import { confirmed } from "../parts";
import type { Mutation } from "../use-resource";
import styles from "../admin.module.css";

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

  async function clear() {
    if (!confirmed(`Remove the injected headers for ${domain.domain}?`)) return;
    const done = await mutation.run(
      () => clearDomainHeaders(teamId, domain.domain),
      () => `Removed the injected headers for ${domain.domain}.`,
    );
    if (done) onChanged();
  }

  if (!editing) {
    return (
      <div>
        {names.length > 0 ? (
          <span>
            {names.map((n) => (
              <code key={n}>{n} </code>
            ))}
          </span>
        ) : (
          <span className={styles.hint}>None</span>
        )}{" "}
        <button type="button" disabled={mutation.pending} onClick={() => setEditing(true)}>
          {names.length > 0 ? "Replace" : "Add"} headers
          <span className={styles.visuallyHidden}> for {domain.domain}</span>
        </button>
        {names.length > 0 ? (
          <button type="button" disabled={mutation.pending} onClick={() => void clear()}>
            Remove headers<span className={styles.visuallyHidden}> for {domain.domain}</span>
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className={styles.form}
      aria-label={`Headers for ${domain.domain}`}
      onSubmit={(e) => void save(e)}
    >
      <p className={styles.hint}>
        Sent by the egress proxy with every request the team&apos;s sandboxes make to{" "}
        <code>http://{domain.domain}/…</code> (upgraded to verified HTTPS). Values are stored
        encrypted and never shown again; saving replaces all headers for this domain.
      </p>
      {rows.map((row, i) => (
        <div key={i}>
          <label htmlFor={`${ids}-n${i}`}>Header name</label>
          <input
            id={`${ids}-n${i}`}
            value={row.name}
            autoComplete="off"
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <label htmlFor={`${ids}-v${i}`}>Value</label>
          <input
            id={`${ids}-v${i}`}
            type="password"
            value={row.value}
            autoComplete="new-password"
            onChange={(e) => update(i, { value: e.target.value })}
          />
        </div>
      ))}
      <div className={styles.actions}>
        {rows.length < MAX_HEADERS ? (
          <button type="button" onClick={() => setRows((all) => [...all, EMPTY])}>
            Another header
          </button>
        ) : null}
        <button type="submit" disabled={mutation.pending}>
          Save headers
        </button>
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
