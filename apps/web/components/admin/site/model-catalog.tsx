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
  type TokenDefaults,
} from "../../../lib/admin/api/site/models";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormRow,
  Notice,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { useFocusAfterRemoval } from "../use-focus-after-removal";
import type { Mutation } from "../use-resource";
import { ALIAS_PATTERN } from "./model-kinds";
import { LimitsFields, limitsChange, limitsText, useLimitsChoice } from "./model-limits";
import { ThinkingFields, thinkingChange, thinkingText, useThinkingChoice } from "./model-thinking";

const HEADING = "catalog-heading";

/**
 * The model catalog (D30 "ceiling"): aliases such as `fast` or `kimi`, each mapped to a provider and
 * one of its model ids. Teams enable a subset; agents and threads name the alias.
 */
export function CatalogSection({
  catalog,
  providers,
  tokenDefaults,
  mutation,
  onChanged,
}: {
  readonly catalog: readonly CatalogModel[];
  readonly providers: readonly ModelProvider[];
  /** What models without their own limits get (KOBE-259); absent from an older server. */
  readonly tokenDefaults: TokenDefaults | undefined;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const focus = useFocusAfterRemoval(
    catalog.map((m) => m.alias),
    HEADING,
  );
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  async function remove(m: CatalogModel, index: number, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Remove ${m.alias} from the catalog?`,
        description:
          "Every team that enabled it loses it, and conversations that chose it stop until they pick another model.",
        confirmLabel: `Remove ${m.alias}`,
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => deleteCatalogModel(m.alias),
      () => `Removed ${m.alias} from the catalog.`,
    );
    if (done) {
      focus.removed(m.alias, index);
      onChanged();
    }
  }

  return (
    <Section
      id={HEADING}
      title="Catalog"
      description="The catalog is the ceiling for teams: team admins enable a subset and pick their default, and people choose among those per conversation. An alias is what agents and threads name, so re-pointing it to another model changes it everywhere at once."
    >
      {catalog.length === 0 ? (
        <EmptyState title="The catalog is empty: no team can use a model yet." />
      ) : (
        <div ref={focus.container}>
          <Table caption={`Catalog models (${catalog.length})`}>
            <TableHead>
              <TableRow>
                <TableHeader>Alias</TableHeader>
                <TableHeader>Shown as</TableHeader>
                <TableHeader>Provider</TableHeader>
                <TableHeader>Model</TableHeader>
                <TableHeader>Input</TableHeader>
                <TableHeader>Limits</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {catalog.map((m, index) => (
                <CatalogRow
                  key={m.alias}
                  model={m}
                  providerName={providerName(m.providerId)}
                  providers={providers}
                  tokenDefaults={tokenDefaults}
                  editing={editing === m.alias}
                  mutation={mutation}
                  onEdit={() => {
                    mutation.clear();
                    setEditing(editing === m.alias ? null : m.alias);
                  }}
                  onRemove={(trigger) => void remove(m, index, trigger)}
                  onSaved={() => {
                    setEditing(null);
                    onChanged();
                  }}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {providers.length === 0 ? (
        <Notice>
          <p>Add a provider first.</p>
        </Notice>
      ) : (
        <AddCatalogForm
          providers={providers}
          tokenDefaults={tokenDefaults}
          mutation={mutation}
          onAdded={onChanged}
        />
      )}
      {confirmDialog}
    </Section>
  );
}

function CatalogRow({
  model: m,
  providerName,
  providers,
  tokenDefaults,
  editing,
  mutation,
  onEdit,
  onRemove,
  onSaved,
}: {
  readonly model: CatalogModel;
  readonly providerName: string;
  readonly providers: readonly ModelProvider[];
  readonly tokenDefaults: TokenDefaults | undefined;
  readonly editing: boolean;
  readonly mutation: Mutation;
  readonly onEdit: () => void;
  readonly onRemove: (trigger: HTMLElement | null) => void;
  readonly onSaved: () => void;
}) {
  return (
    <>
      <TableRow>
        <TableRowHeader>
          <code>{m.alias}</code>
        </TableRowHeader>
        <TableCell>{m.label ?? "—"}</TableCell>
        <TableCell>{providerName}</TableCell>
        <TableCell>
          <code className="break-all">{m.model}</code>
          <br />
          <span className="text-sm text-console-muted">
            Gateway id <code className="break-all">{m.gatewayModel}</code>
          </span>
        </TableCell>
        <TableCell>{m.inputModalities.includes("image") ? "Text, images" : "Text"}</TableCell>
        <TableCell>
          {limitsText(m, tokenDefaults)}
          {thinkingText(m) !== "" && (
            <>
              <br />
              <span className="text-sm text-console-muted">{thinkingText(m)}</span>
            </>
          )}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" aria-expanded={editing} disabled={mutation.pending} onClick={onEdit}>
              {editing ? "Cancel" : "Edit"}
              <span className="sr-only"> {m.alias}</span>
            </Button>
            <Button
              size="sm"
              variant="danger"
              data-remove=""
              disabled={mutation.pending}
              onClick={(e) => onRemove(eventTrigger(e))}
            >
              Remove<span className="sr-only"> {m.alias}</span>
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {editing && (
        <TableRow>
          <TableCell colSpan={7}>
            <EditCatalogForm
              model={m}
              providers={providers}
              tokenDefaults={tokenDefaults}
              mutation={mutation}
              onSaved={onSaved}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function EditCatalogForm({
  model: m,
  providers,
  tokenDefaults,
  mutation,
  onSaved,
}: {
  readonly model: CatalogModel;
  readonly providers: readonly ModelProvider[];
  readonly tokenDefaults: TokenDefaults | undefined;
  readonly mutation: Mutation;
  readonly onSaved: () => void;
}) {
  const [label, setLabel] = useState(m.label ?? "");
  const [providerId, setProviderId] = useState(m.providerId);
  const [model, setModel] = useState(m.model);
  const images = useImageChoice(m.inputModalities.includes("image"));
  const limits = useLimitsChoice(m);
  const thinking = useThinkingChoice(m);
  const kind = providers.find((p) => p.id === providerId)?.kind;

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
      ...limitsChange(limits, m),
      ...thinkingChange(thinking, limits.reasoning, kind, m),
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
    <form onSubmit={onSubmit} aria-label={`Edit ${m.alias}`}>
      <FormRow className="mt-1">
        <LabelField value={label} onChange={setLabel} />
        <ProviderField providers={providers} value={providerId} onChange={setProviderId} />
        <ModelIdField
          providerId={providerId}
          value={model}
          onChange={setModel}
          onReportsImages={images.suggest}
        />
      </FormRow>
      <ImagesField choice={images} />
      <LimitsFields choice={limits} defaults={tokenDefaults} />
      <ThinkingFields choice={thinking} reasoning={limits.reasoning} kind={kind} />
      <Button type="submit" variant="primary" disabled={mutation.pending}>
        Save {m.alias}
      </Button>
    </form>
  );
}

function AddCatalogForm({
  providers,
  tokenDefaults,
  mutation,
  onAdded,
}: {
  readonly providers: readonly ModelProvider[];
  readonly tokenDefaults: TokenDefaults | undefined;
  readonly mutation: Mutation;
  readonly onAdded: () => void;
}) {
  const id = useId();
  const [alias, setAlias] = useState("");
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [model, setModel] = useState("");
  const images = useImageChoice(false);
  const limits = useLimitsChoice();
  const thinking = useThinkingChoice();
  const kind = providers.find((p) => p.id === providerId)?.kind;

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
          ...limitsChange(limits),
          ...thinkingChange(thinking, limits.reasoning, kind),
        }),
      (added) => `Published ${added.alias} (${added.gatewayModel}). Team admins can enable it now.`,
    );
    if (done) {
      setAlias("");
      setLabel("");
      setModel("");
      images.reset();
      limits.reset();
      thinking.reset();
      onAdded();
    }
  }

  return (
    <Section title="Add a model to the catalog" level={3}>
      <form onSubmit={onSubmit} aria-label="Add a catalog model">
        <FormRow className="mt-0">
          <Field label="Alias">
            <TextInput
              required
              maxLength={64}
              pattern={ALIAS_PATTERN}
              placeholder="kimi"
              aria-describedby={`${id}-alias`}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
            />
          </Field>
          <LabelField value={label} onChange={setLabel} />
          <ProviderField providers={providers} value={providerId} onChange={setProviderId} />
          <ModelIdField
            providerId={providerId}
            value={model}
            onChange={setModel}
            onReportsImages={images.suggest}
          />
        </FormRow>
        <p id={`${id}-alias`} className="m-0 mb-3 text-sm text-console-muted">
          Alias: lowercase letters, digits, dots, dashes and underscores, such as <code>fast</code>,{" "}
          <code>smart</code> or <code>kimi-k2.7-code</code>. It can&apos;t be renamed later.
        </p>
        <ImagesField choice={images} />
        <LimitsFields choice={limits} defaults={tokenDefaults} />
        <ThinkingFields choice={thinking} reasoning={limits.reasoning} kind={kind} />
        <Button type="submit" variant="primary" disabled={mutation.pending || providerId === ""}>
          Add to catalog
        </Button>
      </form>
    </Section>
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
    <Checkbox
      className="mb-3"
      label="Accepts images (vision)."
      hint="Image attachments are shown to the model only when this is on."
      checked={choice.checked}
      onChange={(e) => choice.set(e.target.checked)}
    />
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
    <Field label="Shown as (optional)">
      <TextInput
        maxLength={200}
        placeholder="Kimi K2.7 Code"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
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
    <Field label="Provider">
      <Select required value={value} onChange={(e) => onChange(e.target.value)}>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </Field>
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
      <Field label="Model">
        <TextInput
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
      </Field>
      <Button
        disabled={providerId === "" || listing.status === "loading"}
        onClick={() => void refresh()}
      >
        Ask the provider for its models
      </Button>
      <p id={`${id}-status`} role="status" className="m-0 basis-full text-sm text-console-muted">
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
