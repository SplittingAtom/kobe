"use client";

import { useState, type FormEvent } from "react";
import {
  AUTH_LABELS,
  NAME_PATTERN,
  createConnector,
  listConnectors,
  removeConnector,
  updateConnector,
  type Connector,
  type ConnectorAuthKind,
  type ConnectorInput,
} from "../../../lib/admin/api/install/connectors";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import styles from "../admin.module.css";

const NAME_HINT = "Use lowercase letters and digits joined by - or _ (up to 64 characters).";
const EMPTY: ConnectorInput = { name: "", url: "", iconUrl: null, authKind: "none" };

/**
 * The install connector registry (spec D6, D27; `/v1/install/connectors`, KOBE-100): the MCP
 * servers teams may enable. Tool review (KOBE-101) and team enablement (KOBE-104) come later.
 */
export function ConnectorsPage() {
  const { state, reload } = useResource(() => listConnectors());
  const mutation = useMutation();
  const [editing, setEditing] = useState<Connector | null>(null);

  return (
    <>
      <h1>Connector registry</h1>
      <p className={styles.hint}>
        Register remote MCP servers (Streamable HTTP over https). Addresses that are private,
        link-local or cloud metadata are refused. Teams enable a connector themselves; removing one
        that teams already enabled keeps it disabled instead of deleting it.
      </p>
      <ConnectorForm
        key={editing?.id ?? "new"}
        editing={editing}
        mutation={mutation}
        onDone={() => {
          setEditing(null);
          reload();
        }}
        onCancel={() => setEditing(null)}
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="connectors">
        {(connectors) => (
          <ConnectorTable
            connectors={connectors}
            mutation={mutation}
            onEdit={setEditing}
            onChanged={reload}
          />
        )}
      </ResourceView>
    </>
  );
}

function ConnectorForm({
  editing,
  mutation,
  onDone,
  onCancel,
}: {
  readonly editing: Connector | null;
  readonly mutation: Mutation;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const initial: ConnectorInput = editing
    ? { name: editing.name, url: editing.url, iconUrl: editing.iconUrl, authKind: editing.authKind }
    : EMPTY;
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(initial.url);
  const [iconUrl, setIconUrl] = useState(initial.iconUrl ?? "");
  const [authKind, setAuthKind] = useState<ConnectorAuthKind>(initial.authKind);
  const [problem, setProblem] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: ConnectorInput = {
      name: name.trim(),
      url: url.trim(),
      iconUrl: iconUrl.trim() === "" ? null : iconUrl.trim(),
      authKind,
    };
    if (!NAME_PATTERN.test(next.name) || next.name.length > 64) {
      setProblem(NAME_HINT);
      return;
    }
    setProblem(null);
    const done = await mutation.run(
      () => (editing ? updateConnector(editing.id, changes(editing, next)) : createConnector(next)),
      () => (editing ? "Saved." : "Registered."),
    );
    if (done) onDone();
  }

  return (
    <form
      onSubmit={onSubmit}
      className={styles.form}
      aria-label={editing ? "Edit connector" : "Register a connector"}
    >
      <label>
        Name
        <input
          required
          maxLength={64}
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Server URL
        <input
          required
          type="url"
          maxLength={2048}
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label>
        Icon URL (optional)
        <input
          type="url"
          maxLength={2048}
          spellCheck={false}
          value={iconUrl}
          onChange={(e) => setIconUrl(e.target.value)}
        />
      </label>
      <label>
        Authentication
        <select value={authKind} onChange={(e) => setAuthKind(e.target.value as ConnectorAuthKind)}>
          {(Object.keys(AUTH_LABELS) as ConnectorAuthKind[]).map((k) => (
            <option key={k} value={k}>
              {AUTH_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {problem ? <p role="alert">{problem}</p> : null}
      <button type="submit" disabled={mutation.pending}>
        {editing ? "Save changes" : "Register connector"}
      </button>
      {editing ? (
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </form>
  );
}

/** Only the fields that differ, so an edit never re-sends (and re-validates) the URL needlessly. */
function changes(current: Connector, next: ConnectorInput): Partial<ConnectorInput> {
  return {
    ...(next.name !== current.name ? { name: next.name } : {}),
    ...(next.url !== current.url ? { url: next.url } : {}),
    ...(next.iconUrl !== current.iconUrl ? { iconUrl: next.iconUrl } : {}),
    ...(next.authKind !== current.authKind ? { authKind: next.authKind } : {}),
  };
}

function ConnectorTable({
  connectors,
  mutation,
  onEdit,
  onChanged,
}: {
  readonly connectors: readonly Connector[];
  readonly mutation: Mutation;
  readonly onEdit: (c: Connector) => void;
  readonly onChanged: () => void;
}) {
  async function toggle(c: Connector) {
    const status = c.status === "active" ? "disabled" : "active";
    const done = await mutation.run(
      () => updateConnector(c.id, { status }),
      () => (status === "disabled" ? "Disabled." : "Enabled."),
    );
    if (done) onChanged();
  }

  async function remove(c: Connector) {
    if (!confirmed(`Remove the connector ${c.name} from the registry?`)) return;
    const done = await mutation.run(
      () => removeConnector(c.id),
      (r) => r.message,
    );
    if (done) onChanged();
  }

  if (connectors.length === 0) return <p>No connectors are registered.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>Registered connectors</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Server URL</th>
            <th scope="col">Authentication</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className={styles.visuallyHidden}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {connectors.map((c) => (
            <tr key={c.id}>
              <th scope="row">
                {c.iconUrl ? (
                  <img src={c.iconUrl} alt="" width={20} height={20} referrerPolicy="no-referrer" />
                ) : null}{" "}
                {c.name}
              </th>
              <td>
                <code>{c.url}</code>
              </td>
              <td>{AUTH_LABELS[c.authKind]}</td>
              <td>{c.status === "active" ? "Active" : "Disabled"}</td>
              <td>
                <DateTime value={c.updatedAt} />
              </td>
              <td>
                <button type="button" disabled={mutation.pending} onClick={() => onEdit(c)}>
                  Edit<span className={styles.visuallyHidden}> {c.name}</span>
                </button>{" "}
                <button type="button" disabled={mutation.pending} onClick={() => void toggle(c)}>
                  {c.status === "active" ? "Disable" : "Enable"}
                  <span className={styles.visuallyHidden}> {c.name}</span>
                </button>{" "}
                <button type="button" disabled={mutation.pending} onClick={() => void remove(c)}>
                  Remove<span className={styles.visuallyHidden}> {c.name}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
