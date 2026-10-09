"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import type { ApiError } from "../../../lib/api/client";
import {
  addCatalogModel,
  deleteCatalogModel,
  listProviderModels,
  refreshProviderModels,
  updateCatalogModel,
  type CatalogModel,
  type ModelProvider,
  type ProviderModels,
} from "../../../lib/admin/api/install/models";
import { confirmed } from "../parts";
import type { Mutation } from "../use-resource";
import { ALIAS_PATTERN } from "./model-kinds";
import styles from "../admin.module.css";

/**
 * The model catalog (D30 "ceiling"): aliases such as `fast` or `kimi`, each mapped to a provider and
 * one of its model ids. Teams enable a subset; agents and threads name the alias.
 */
export function CatalogSection({
  catalog,
  providers,
  mutation,
  onChanged,
}: {
  readonly catalog: readonly CatalogModel[];
  readonly providers: readonly ModelProvider[];
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  async function remove(m: CatalogModel) {
    if (
      !confirmed(
        `Remove ${m.alias} from the catalog? Every team that enabled it loses it, and conversations that chose it stop until they pick another model.`,
      )
    ) {
      return;
    }
    const done = await mutation.run(
      () => deleteCatalogModel(m.alias),
      () => `Removed ${m.alias} from the catalog.`,
    );
    if (done) onChanged();
  }

  return (
    <section aria-labelledby="catalog-heading">
      <h2 id="catalog-heading">Catalog</h2>
      <p className={styles.hint}>
        The catalog is the ceiling for teams: team admins enable a subset and pick their default,
        and people choose among those per conversation. An alias is what agents and threads name, so
        re-pointing it to another model changes it everywhere at once.
      </p>
      {catalog.length === 0 ? (
        <p>The catalog is empty: no team can use a model yet.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Catalog models ({catalog.length})</caption>
            <thead>
              <tr>
                <th scope="col">Alias</th>
                <th scope="col">Shown as</th>
                <th scope="col">Provider</th>
                <th scope="col">Model</th>
                <th scope="col">Input</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((m) => (
                <CatalogRow
                  key={m.alias}
                  model={m}
                  providerName={providerName(m.providerId)}
                  providers={providers}
                  editing={editing === m.alias}
                  mutation={mutation}
                  onEdit={() => {
                    mutation.clear();
                    setEditing(editing === m.alias ? null : m.alias);
                  }}
                  onRemove={() => void remove(m)}
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
      {providers.length === 0 ? (
        <p>Add a provider first.</p>
      ) : (
        <AddCatalogForm providers={providers} mutation={mutation} onAdded={onChanged} />
      )}
    </section>
  );
}

function CatalogRow({
  model: m,
  providerName,
  providers,
  editing,
  mutation,
  onEdit,
  onRemove,
  onSaved,
}: {
  readonly model: CatalogModel;
  readonly providerName: string;
  readonly providers: readonly ModelProvider[];
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
          <code>{m.alias}</code>
        </th>
        <td>{m.label ?? "—"}</td>
        <td>{providerName}</td>
        <td>
          <code>{m.model}</code>
          <br />
          <span className={styles.hint}>
            Gateway id <code>{m.gatewayModel}</code>
          </span>
        </td>
        <td>{m.inputModalities.includes("image") ? "Text, images" : "Text"}</td>
        <td>
          <div className={styles.actions}>
            <button
              type="button"
              aria-expanded={editing}
              disabled={mutation.pending}
              onClick={onEdit}
            >
              {editing ? "Cancel" : "Edit"}
              <span className={styles.visuallyHidden}> {m.alias}</span>
            </button>
            <button type="button" disabled={mutation.pending} onClick={onRemove}>
              Remove<span className={styles.visuallyHidden}> {m.alias}</span>
            </button>
          </div>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={6}>
            <EditCatalogForm
              model={m}
              providers={providers}
              mutation={mutation}
              onSaved={onSaved}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function EditCatalogForm({
  model: m,
  providers,
  mutation,
  onSaved,
}: {
  readonly model: CatalogModel;
  readonly providers: readonly ModelProvider[];
  readonly mutation: Mutation;
  readonly onSaved: () => void;
}) {
  const [label, setLabel] = useState(m.label ?? "");
  const [providerId, setProviderId] = useState(m.providerId);
  const [model, setModel] = useState(m.model);
  const images = useImageChoice(m.inputModalities.includes("image"));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const nextLabel = label.trim() === "" ? null : label.trim();
    const change = {
      ...(nextLabel !== m.label ? { label: nextLabel } : {}),
      ...(providerId !== m.providerId ? { providerId } : {}),
      ...(model.trim() !== m.model ? { model: model.trim() } : {}),
      ...(images.checked !== m.inputModalities.includes("image")
        ? { inputModalities: modalitiesOf(images.checked) }
        : {}),
    };
    if (Object.keys(change).length === 0) {
      onSaved();
      return;
    }
    const done = await mutation.run(
      () => updateCatalogModel(m.alias, change),
      (saved) => `Saved ${saved.alias}: ${saved.gatewayModel}.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} className={styles.form} aria-label={`Edit ${m.alias}`}>
      <LabelField value={label} onChange={setLabel} />
      <ProviderField providers={providers} value={providerId} onChange={setProviderId} />
      <ModelIdField
        providerId={providerId}
        value={model}
        onChange={setModel}
        onReportsImages={images.suggest}
      />
      <ImagesField choice={images} />
      <button type="submit" disabled={mutation.pending}>
        Save {m.alias}
      </button>
    </form>
  );
}

function AddCatalogForm({
  providers,
  mutation,
  onAdded,
}: {
  readonly providers: readonly ModelProvider[];
  readonly mutation: Mutation;
  readonly onAdded: () => void;
}) {
  const id = useId();
  const [alias, setAlias] = useState("");
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [model, setModel] = useState("");
  const images = useImageChoice(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () =>
        addCatalogModel({
          alias: alias.trim(),
          providerId,
          model: model.trim(),
          label: label.trim() === "" ? null : label.trim(),
          ...(images.checked ? { inputModalities: modalitiesOf(true) } : {}),
        }),
      (added) => `Published ${added.alias} (${added.gatewayModel}). Team admins can enable it now.`,
    );
    if (done) {
      setAlias("");
      setLabel("");
      setModel("");
      images.reset();
      onAdded();
    }
  }

  return (
    <>
      <h3>Add a model to the catalog</h3>
      <form onSubmit={onSubmit} className={styles.form} aria-label="Add a catalog model">
        <label>
          Alias
          <input
            required
            maxLength={64}
            pattern={ALIAS_PATTERN}
            placeholder="kimi"
            aria-describedby={`${id}-alias`}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
        </label>
        <LabelField value={label} onChange={setLabel} />
        <ProviderField providers={providers} value={providerId} onChange={setProviderId} />
        <ModelIdField
          providerId={providerId}
          value={model}
          onChange={setModel}
          onReportsImages={images.suggest}
        />
        <ImagesField choice={images} />
        <button type="submit" disabled={mutation.pending || providerId === ""}>
          Add to catalog
        </button>
        <p id={`${id}-alias`} className={styles.hint}>
          Alias: lowercase letters, digits, dots, dashes and underscores, such as <code>fast</code>,{" "}
          <code>smart</code> or <code>kimi-k2.7-code</code>. It can&apos;t be renamed later.
        </p>
      </form>
    </>
  );
}

const modalitiesOf = (images: boolean): string[] => (images ? ["text", "image"] : ["text"]);

interface ImageChoice {
  readonly checked: boolean;
  /** The admin's own click: from then on the provider's hint no longer changes it. */
  readonly set: (v: boolean) => void;
  /** The provider reports the picked model takes images: tick the box unless the admin chose. */
  readonly suggest: () => void;
  readonly reset: () => void;
}

function useImageChoice(initial: boolean): ImageChoice {
  const [checked, setChecked] = useState(initial);
  const [chosen, setChosen] = useState(false);
  return {
    checked,
    set: (v) => {
      setChosen(true);
      setChecked(v);
    },
    suggest: () => {
      if (!chosen) setChecked(true);
    },
    reset: () => {
      setChosen(false);
      setChecked(initial);
    },
  };
}

function ImagesField({ choice }: { readonly choice: ImageChoice }) {
  return (
    <label>
      <input
        type="checkbox"
        checked={choice.checked}
        onChange={(e) => choice.set(e.target.checked)}
      />{" "}
      Accepts images (vision). Image attachments are shown to the model only when this is on.
    </label>
  );
}

function LabelField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
}) {
  return (
    <label>
      Shown as (optional)
      <input
        maxLength={200}
        placeholder="Kimi K2.7 Code"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ProviderField({
  providers,
  value,
  onChange,
}: {
  readonly providers: readonly ModelProvider[];
  readonly value: string;
  readonly onChange: (v: string) => void;
}) {
  return (
    <label>
      Provider
      <select required value={value} onChange={(e) => onChange(e.target.value)}>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

type Listing =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly data: ProviderModels }
  | { readonly status: "error"; readonly error: ApiError };

/**
 * The model id, typed or picked from what the provider serves: the gateway's list (cached in
 * Bifrost) loads with the provider, and "Ask the provider" has the gateway list them again with
 * the provider's key. A free-text input with a datalist, so an unlisted model still works.
 */
export function ModelIdField({
  providerId,
  value,
  onChange,
  onReportsImages,
}: {
  readonly providerId: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  /** Called when the typed or picked id is one the provider reports as accepting images. */
  readonly onReportsImages?: () => void;
}) {
  const id = useId();
  const [listing, setListing] = useState<Listing>({ status: "idle" });

  useEffect(() => {
    if (providerId === "") return;
    let current = true;
    setListing({ status: "loading" });
    void listProviderModels(providerId).then((res) => {
      if (current) {
        setListing(
          res.ok ? { status: "ready", data: res.data } : { status: "error", error: res.error },
        );
      }
    });
    return () => {
      current = false;
    };
  }, [providerId]);

  async function refresh() {
    setListing({ status: "loading" });
    const res = await refreshProviderModels(providerId);
    setListing(
      res.ok ? { status: "ready", data: res.data } : { status: "error", error: res.error },
    );
  }

  const models = listing.status === "ready" ? listing.data.models : [];
  return (
    <>
      <label>
        Model
        <input
          required
          maxLength={200}
          list={`${id}-models`}
          autoComplete="off"
          spellCheck={false}
          placeholder="kimi-k2.7-code"
          aria-describedby={`${id}-status`}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (listing.status === "ready" && listing.data.imageModels.includes(e.target.value)) {
              onReportsImages?.();
            }
          }}
        />
        <datalist id={`${id}-models`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <button
        type="button"
        disabled={providerId === "" || listing.status === "loading"}
        onClick={() => void refresh()}
      >
        Ask the provider for its models
      </button>
      <p id={`${id}-status`} role="status" className={styles.hint}>
        {listingText(listing)}
      </p>
    </>
  );
}

function listingText(listing: Listing): string {
  switch (listing.status) {
    case "idle":
      return "";
    case "loading":
      return "Listing the provider's models…";
    case "error":
      return `${listing.error.message} You can still type the model id.`;
    case "ready": {
      const { models, discovery, detail, truncated } = listing.data;
      if (discovery === "failed") {
        return `The provider refused to list its models${detail ? `: ${detail}` : ""}. Check its key and endpoint, or type the model id.`;
      }
      if (models.length === 0) {
        return "No models listed yet. Ask the provider, or type the model id.";
      }
      const shown = `${models.length}${truncated ? "+" : ""} model${models.length === 1 ? "" : "s"}`;
      return `${shown} available: pick one from the suggestions or type another.`;
    }
  }
}
