"use client";

import { useId, useState, type FormEvent } from "react";
import {
  PROVIDER_KINDS,
  addProvider,
  deleteProvider,
  updateProvider,
  type CatalogModel,
  type ModelProvider,
  type ProviderChange,
  type ProviderKind,
} from "../../../lib/admin/api/install/models";
import { confirmed } from "../parts";
import type { Mutation } from "../use-resource";
import { KINDS, PROVIDER_ID_PATTERN, insecureForKey, kindLabel } from "./model-kinds";
import styles from "../admin.module.css";

/**
 * Providers (KOBE-44 over the KOBE-40 API): add, edit, remove. API keys are write-only: the page
 * shows only whether one is set, and a keyed provider's endpoint moves only with its key re-entered.
 */
export function ProvidersSection({
  providers,
  catalog,
  configured,
  mutation,
  onChanged,
}: {
  readonly providers: readonly ModelProvider[];
  readonly catalog: readonly CatalogModel[];
  readonly configured: boolean;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  async function remove(p: ModelProvider) {
    const used = catalog.filter((m) => m.providerId === p.id).length;
    const question =
      used > 0
        ? `${p.name} still serves ${used} catalog model${used === 1 ? "" : "s"}; the server will refuse until they are removed or re-pointed. Try anyway?`
        : `Remove ${p.name}? Its stored API key is deleted.`;
    if (!confirmed(question)) return;
    const done = await mutation.run(
      () => deleteProvider(p.id),
      () => `Removed ${p.name}.`,
    );
    if (done) onChanged();
  }

  return (
    <section aria-labelledby="providers-heading">
      <h2 id="providers-heading">Providers</h2>
      <p className={styles.hint}>
        Provider API keys stay on the server and in the model gateway: sandboxes never see them, and
        this page never shows them again after you save one.
      </p>
      {providers.length === 0 ? (
        <p>No providers yet. Add one below, then publish its models in the catalog.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Providers ({providers.length})</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Kind</th>
                <th scope="col">Endpoint</th>
                <th scope="col">API key</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  editing={editing === p.id}
                  mutation={mutation}
                  onEdit={() => {
                    mutation.clear();
                    setEditing(editing === p.id ? null : p.id);
                  }}
                  onRemove={() => void remove(p)}
                  onSaved={() => {
                    setEditing(null);
                    onChanged();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {configured ? (
        <AddProviderForm providers={providers} mutation={mutation} onAdded={onChanged} />
      ) : (
        <p className={styles.banner}>
          The model gateway is not configured on this install, so providers can&apos;t be added. Set
          the chart&apos;s <code>bifrost</code> values and upgrade.
        </p>
      )}
    </section>
  );
}

function ProviderRow({
  provider: p,
  editing,
  mutation,
  onEdit,
  onRemove,
  onSaved,
}: {
  readonly provider: ModelProvider;
  readonly editing: boolean;
  readonly mutation: Mutation;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onSaved: () => void;
}) {
  return (
    <>
      <tr>
        <th scope="row">
          {p.name}
          <br />
          <code className={styles.hint}>{p.id}</code>
        </th>
        <td>{kindLabel(p.kind)}</td>
        <td>
          {p.baseUrl ? <code>{p.baseUrl}</code> : "Vendor endpoint"}
          {p.allowPrivateNetwork && <span className={styles.hint}> · private network allowed</span>}
        </td>
        <td>{p.keySet ? `Set (revision ${p.keyRevision})` : "Not set"}</td>
        <td>
          <div className={styles.actions}>
            <button
              type="button"
              aria-expanded={editing}
              disabled={mutation.pending}
              onClick={onEdit}
            >
              {editing ? "Cancel" : "Edit"}
              <span className={styles.visuallyHidden}> {p.name}</span>
            </button>
            <button type="button" disabled={mutation.pending} onClick={onRemove}>
              Remove<span className={styles.visuallyHidden}> {p.name}</span>
            </button>
          </div>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5}>
            <EditProviderForm provider={p} mutation={mutation} onSaved={onSaved} />
          </td>
        </tr>
      )}
    </>
  );
}

function EditProviderForm({
  provider: p,
  mutation,
  onSaved,
}: {
  readonly provider: ModelProvider;
  readonly mutation: Mutation;
  readonly onSaved: () => void;
}) {
  const id = useId();
  const info = KINDS[p.kind];
  const [name, setName] = useState(p.name);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [privateNetwork, setPrivateNetwork] = useState(p.allowPrivateNetwork);

  const urlChanged = info.endpoint === "required" && baseUrl.trim() !== (p.baseUrl ?? "");
  const newKey = apiKey.trim();
  // KOBE-40: a stored key never follows an endpoint change; whoever moves it re-enters the key.
  const needsKey = urlChanged && p.keySet && newKey === "" && !removeKey;
  const keyAfter = newKey !== "" || (p.keySet && !removeKey);
  const insecure = urlChanged && insecureForKey(baseUrl, keyAfter);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const change: ProviderChange = {
      ...(name.trim() !== p.name ? { name: name.trim() } : {}),
      ...(urlChanged ? { baseUrl: baseUrl.trim() } : {}),
      ...(newKey !== "" ? { apiKey: newKey } : removeKey ? { apiKey: null } : {}),
      ...(privateNetwork !== p.allowPrivateNetwork ? { allowPrivateNetwork: privateNetwork } : {}),
    };
    if (Object.keys(change).length === 0) {
      onSaved();
      return;
    }
    const done = await mutation.run(
      () => updateProvider(p.id, change),
      (saved) =>
        `Saved ${saved.name}.${change.apiKey ? " The new key replaced the old one." : ""} The gateway picks it up within seconds.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} className={styles.form} aria-label={`Edit ${p.name}`}>
      <label>
        Name
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {info.endpoint === "required" && (
        <label>
          Base URL
          <input
            required
            type="url"
            maxLength={2048}
            value={baseUrl}
            aria-describedby={`${id}-url-hint`}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      )}
      <label>
        {p.keySet ? "New API key (optional)" : "API key (optional)"}
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          value={apiKey}
          required={needsKey}
          placeholder={p.keySet ? "Leave empty to keep the stored key" : ""}
          aria-describedby={`${id}-key-hint`}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      {info.key === "optional" && p.keySet && (
        <label>
          <span>
            <input
              type="checkbox"
              checked={removeKey}
              disabled={newKey !== ""}
              onChange={(e) => setRemoveKey(e.target.checked)}
            />{" "}
            Remove the stored key
          </span>
        </label>
      )}
      {info.endpoint === "required" && (
        <label>
          <span>
            <input
              type="checkbox"
              checked={privateNetwork}
              onChange={(e) => setPrivateNetwork(e.target.checked)}
            />{" "}
            Allow private network addresses
          </span>
        </label>
      )}
      <button type="submit" disabled={mutation.pending || needsKey}>
        Save {p.name}
      </button>
      <p id={`${id}-url-hint`} className={styles.hint}>
        {p.keySet
          ? "The stored key is only ever sent to this endpoint. Changing the endpoint needs the API key again."
          : info.hint}
      </p>
      <p id={`${id}-key-hint`} className={styles.hint}>
        Keys are write-only: the current key is never shown. A new key replaces it.
      </p>
      {needsKey && (
        <p role="alert" className={styles.banner}>
          You changed the endpoint of a provider with a stored key. Enter the API key again to send
          it to the new endpoint: Kobe never moves a stored key to another address.
        </p>
      )}
      {insecure && (
        <p role="alert" className={styles.banner}>
          The server sends API keys over https:// only (unless the operator allowed unsafe endpoints
          for a test install). Use an https:// URL, or remove the key.
        </p>
      )}
    </form>
  );
}

function AddProviderForm({
  providers,
  mutation,
  onAdded,
}: {
  readonly providers: readonly ModelProvider[];
  readonly mutation: Mutation;
  readonly onAdded: () => void;
}) {
  const id = useId();
  const taken = new Set(providers.map((p) => p.id));
  const firstFree = PROVIDER_KINDS.find((k) => !KINDS[k].single || !taken.has(k)) ?? "ollama";
  const [kind, setKind] = useState<ProviderKind>(firstFree);
  const [providerId, setProviderId] = useState("");
  const [name, setName] = useState(KINDS[firstFree].label);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [privateNetwork, setPrivateNetwork] = useState(false);
  const info = KINDS[kind];
  const insecure = info.endpoint === "required" && insecureForKey(baseUrl, apiKey.trim() !== "");

  function chooseKind(next: ProviderKind) {
    if (name === "" || name === KINDS[kind].label) setName(KINDS[next].label);
    setKind(next);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () =>
        addProvider({
          kind,
          ...(kind === "openai_compatible" ? { id: providerId.trim() } : {}),
          name: name.trim(),
          ...(info.endpoint === "required" ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
          allowPrivateNetwork: info.endpoint === "required" && privateNetwork,
        }),
      (added) =>
        `Added ${added.name}. Publish its models in the catalog below; the gateway picks it up within seconds.`,
    );
    if (done) {
      setProviderId("");
      setBaseUrl("");
      setApiKey("");
      setPrivateNetwork(false);
      onAdded();
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.form} aria-label="Add a provider">
      <label>
        Kind
        <select value={kind} onChange={(e) => chooseKind(e.target.value as ProviderKind)}>
          {PROVIDER_KINDS.map((k) => (
            <option key={k} value={k} disabled={KINDS[k].single && taken.has(k)}>
              {KINDS[k].label}
              {KINDS[k].single && taken.has(k) ? " (added)" : ""}
            </option>
          ))}
        </select>
      </label>
      {kind === "openai_compatible" && (
        <label>
          ID
          <input
            required
            maxLength={32}
            pattern={PROVIDER_ID_PATTERN}
            placeholder="vllm"
            title="Lowercase letters, digits and dashes"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          />
        </label>
      )}
      <label>
        Name
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {info.endpoint === "required" && (
        <label>
          Base URL
          <input
            required
            type="url"
            maxLength={2048}
            placeholder={info.urlPlaceholder}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      )}
      <label>
        {info.key === "required" ? "API key" : "API key (optional)"}
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          required={info.key === "required"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      {info.endpoint === "required" && (
        <label>
          <span>
            <input
              type="checkbox"
              checked={privateNetwork}
              onChange={(e) => setPrivateNetwork(e.target.checked)}
            />{" "}
            Allow private network addresses
          </span>
        </label>
      )}
      <button type="submit" disabled={mutation.pending}>
        Add provider
      </button>
      <p id={`${id}-hint`} className={styles.hint}>
        {info.hint}
        {info.endpoint === "required" &&
          " Private addresses (a server in your cluster or LAN) also need an egress rule for the gateway in the chart (bifrost.networkPolicy.extraEgress)."}
      </p>
      {insecure && (
        <p role="alert" className={styles.banner}>
          The server sends API keys over https:// only (unless the operator allowed unsafe endpoints
          for a test install). Use an https:// URL, or leave the key empty.
        </p>
      )}
    </form>
  );
}
