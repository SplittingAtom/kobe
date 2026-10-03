"use client";

import { useState, type FormEvent } from "react";
import {
  addCeilingDomain,
  deleteCeilingDomain,
  getEgressCeiling,
  setCeilingMembership,
  setPresetMembership,
  type CeilingDomain,
  type EgressCeiling,
  type EgressPreset,
} from "../../../lib/admin/api/install/egress";
import { MutationStatus } from "../error-notice";
import { ResourceView, confirmed } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import styles from "../admin.module.css";

export const PRESET_LABEL: Readonly<Record<EgressPreset, string>> = {
  package_registries: "Package registries",
  git_hosts: "Git hosts",
  web_search: "Web search provider",
};

/** The install egress ceiling (spec D6/D28; `/v1/install/egress-ceiling`, KOBE-38). */
export function EgressCeilingPage() {
  const { state, reload } = useResource(getEgressCeiling);
  const mutation = useMutation();
  return (
    <>
      <h1>Egress ceiling</h1>
      <p className={styles.hint}>
        Sandboxes reach the internet only through Kobe&apos;s egress proxy, over HTTPS, and only to
        domains their team enabled. The ceiling is what teams may enable: a fresh install reaches
        nothing, and package registries sit in the ceiling but are off for every team until a team
        admin enables them. Sandboxes have no DNS of their own; the proxy resolves names and never
        connects to internal addresses.
      </p>
      <AddDomainForm mutation={mutation} onAdded={reload} />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="egress ceiling">
        {(ceiling) => <CeilingTables ceiling={ceiling} mutation={mutation} onChanged={reload} />}
      </ResourceView>
    </>
  );
}

function AddDomainForm({
  mutation,
  onAdded,
}: {
  readonly mutation: Mutation;
  readonly onAdded: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [note, setNote] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => addCeilingDomain(domain.trim(), note.trim() === "" ? null : note.trim()),
      (added) => [`Added ${added.domain} to the ceiling.`, ...added.warnings].join(" "),
    );
    if (done) {
      setDomain("");
      setNote("");
      onAdded();
    }
  }

  return (
    <>
      <form onSubmit={onSubmit} className={styles.form} aria-label="Add a domain">
        <label>
          Domain
          <input
            required
            maxLength={253}
            placeholder="api.example.com"
            aria-describedby="egress-domain-hint"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </label>
        <label>
          Note (optional)
          <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit" disabled={mutation.pending}>
          Add domain
        </button>
      </form>
      <p id="egress-domain-hint" className={styles.hint}>
        A host name such as <code>api.example.com</code>, or <code>*.example.com</code> for every
        subdomain (not <code>example.com</code> itself). No IP addresses, schemes or paths.
      </p>
    </>
  );
}

function CeilingTables({
  ceiling,
  mutation,
  onChanged,
}: {
  readonly ceiling: EgressCeiling;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const custom = ceiling.domains.filter((d) => d.preset === null);
  const presets = ceiling.presets.filter((p) => ceiling.domains.some((d) => d.preset === p));

  async function toggle(d: CeilingDomain) {
    const done = await mutation.run(
      () => setCeilingMembership(d.domain, !d.inCeiling),
      (saved) =>
        saved.inCeiling
          ? `${saved.domain} is in the ceiling: teams may enable it.`
          : `${saved.domain} left the ceiling: no team's sandboxes reach it now.`,
    );
    if (done) onChanged();
  }

  async function togglePreset(preset: EgressPreset, inCeiling: boolean) {
    const done = await mutation.run(
      () => setPresetMembership(preset, inCeiling),
      () =>
        `${PRESET_LABEL[preset]}: ${inCeiling ? "all in the ceiling" : "all out of the ceiling"}.`,
    );
    if (done) onChanged();
  }

  async function remove(d: CeilingDomain) {
    if (!confirmed(`Delete ${d.domain}? Every team that enabled it loses it.`)) return;
    const done = await mutation.run(
      () => deleteCeilingDomain(d.domain),
      () => `Deleted ${d.domain}.`,
    );
    if (done) onChanged();
  }

  return (
    <>
      {presets.map((preset) => {
        const rows = ceiling.domains.filter((d) => d.preset === preset);
        return (
          <section key={preset} aria-label={PRESET_LABEL[preset]}>
            <h2>{PRESET_LABEL[preset]}</h2>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={mutation.pending || rows.every((r) => r.inCeiling)}
                onClick={() => void togglePreset(preset, true)}
              >
                Add all {PRESET_LABEL[preset].toLowerCase()}
              </button>
              <button
                type="button"
                disabled={mutation.pending || rows.every((r) => !r.inCeiling)}
                onClick={() => void togglePreset(preset, false)}
              >
                Remove all {PRESET_LABEL[preset].toLowerCase()}
              </button>
            </div>
            <DomainTable
              caption={PRESET_LABEL[preset]}
              rows={rows}
              pending={mutation.pending}
              onToggle={toggle}
            />
          </section>
        );
      })}
      <section aria-label="Custom domains">
        <h2>Custom domains</h2>
        {custom.length === 0 ? (
          <p>No custom domains yet.</p>
        ) : (
          <DomainTable
            caption="Custom domains"
            rows={custom}
            pending={mutation.pending}
            onToggle={toggle}
            onDelete={remove}
          />
        )}
      </section>
    </>
  );
}

function DomainTable({
  caption,
  rows,
  pending,
  onToggle,
  onDelete,
}: {
  readonly caption: string;
  readonly rows: readonly CeilingDomain[];
  readonly pending: boolean;
  readonly onToggle: (d: CeilingDomain) => Promise<void>;
  readonly onDelete?: (d: CeilingDomain) => Promise<void>;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Domain</th>
            <th scope="col">In ceiling</th>
            <th scope="col">Note</th>
            {onDelete ? (
              <th scope="col">
                <span className={styles.visuallyHidden}>Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.domain}>
              <th scope="row">
                <code>{d.domain}</code>
                {d.sharedHosting ? <SharedHostingNote /> : null}
              </th>
              <td>
                <label>
                  <input
                    type="checkbox"
                    checked={d.inCeiling}
                    disabled={pending}
                    onChange={() => void onToggle(d)}
                  />
                  <span className={styles.visuallyHidden}> {d.domain} in the ceiling</span>
                </label>
              </td>
              <td>{d.note ?? ""}</td>
              {onDelete ? (
                <td>
                  <button type="button" disabled={pending} onClick={() => void onDelete(d)}>
                    Delete<span className={styles.visuallyHidden}> {d.domain}</span>
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Domain fronting (KOBE-38): the proxy sees only the TLS server name. */
export function SharedHostingNote() {
  return (
    <span className={styles.hint}>
      {" "}
      Shared hosting or CDN: a sandbox allowed here may also reach other sites behind the same front
      (domain fronting).
    </span>
  );
}
