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
import { KINDS, PROVIDER_ID_PATTERN, insecureForKey, kindLabel } from "./model-kinds";

const HEADING = "providers-heading";

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
  const [confirm, confirmDialog] = useConfirm();
  const focus = useFocusAfterRemoval(
    providers.map((p) => p.id),
    HEADING,
  );

  async function remove(p: ModelProvider, index: number, trigger: HTMLElement | null) {
    const used = catalog.filter((m) => m.providerId === p.id).length;
    const yes = await confirm(
      used > 0
        ? {
            title: `${p.name} still serves ${used} catalog model${used === 1 ? "" : "s"}.`,
            description: "The server will refuse until they are removed or re-pointed. Try anyway?",
            confirmLabel: `Remove ${p.name}`,
          }
        : {
            title: `Remove ${p.name}?`,
            description: "Its stored API key is deleted.",
            confirmLabel: `Remove ${p.name}`,
          },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => deleteProvider(p.id),
      () => `Removed ${p.name}.`,
    );
    if (done) {
      focus.removed(p.id, index);
      onChanged();
    }
  }

  return (
    <Section
      id={HEADING}
      title="Providers"
      description="Provider API keys stay on the server and in the model gateway: sandboxes never see them, and this page never shows them again after you save one."
    >
      {providers.length === 0 ? (
        <EmptyState title="No providers yet.">
          Add one below, then publish its models in the catalog.
        </EmptyState>
      ) : (
        <div ref={focus.container}>
          <Table caption={`Providers (${providers.length})`}>
            <TableHead>
              <TableRow>
                <TableHeader>Provider</TableHeader>
                <TableHeader>Kind</TableHeader>
                <TableHeader>Endpoint</TableHeader>
                <TableHeader>API key</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {providers.map((p, index) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  editing={editing === p.id}
                  mutation={mutation}
                  onEdit={() => {
                    mutation.clear();
                    setEditing(editing === p.id ? null : p.id);
                  }}
                  onRemove={(trigger) => void remove(p, index, trigger)}
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
      {configured ? (
        <AddProviderForm providers={providers} mutation={mutation} onAdded={onChanged} />
      ) : (
        <Notice tone="warn">
          <p>
            The model gateway is not configured on this site, so providers can&apos;t be added. Set
            the chart&apos;s <code>bifrost</code> values and upgrade.
          </p>
        </Notice>
      )}
      {confirmDialog}
    </Section>
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
  readonly onRemove: (trigger: HTMLElement | null) => void;
  readonly onSaved: () => void;
}) {
  return (
    <>
      <TableRow>
        <TableRowHeader>
          {p.name}
          <br />
          <code className="text-sm font-normal text-console-muted">{p.id}</code>
        </TableRowHeader>
        <TableCell>{kindLabel(p.kind)}</TableCell>
        <TableCell>
          {p.baseUrl ? <code className="break-all">{p.baseUrl}</code> : "Vendor endpoint"}
          {p.allowPrivateNetwork && (
            <span className="text-sm text-console-muted"> · private network allowed</span>
          )}
        </TableCell>
        <TableCell>{p.keySet ? `Set (revision ${p.keyRevision})` : "Not set"}</TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" aria-expanded={editing} disabled={mutation.pending} onClick={onEdit}>
              {editing ? "Cancel" : "Edit"}
              <span className="sr-only"> {p.name}</span>
            </Button>
            <Button
              size="sm"
              variant="danger"
              data-remove=""
              disabled={mutation.pending}
              onClick={(e) => onRemove(eventTrigger(e))}
            >
              Remove<span className="sr-only"> {p.name}</span>
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {editing && (
        <TableRow>
          <TableCell colSpan={5}>
            <EditProviderForm provider={p} mutation={mutation} onSaved={onSaved} />
          </TableCell>
        </TableRow>
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
    <form onSubmit={onSubmit} aria-label={`Edit ${p.name}`}>
      <FormRow className="mt-1">
        <Field label="Name">
          <TextInput
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {info.endpoint === "required" && (
          <Field label="Base URL">
            <TextInput
              required
              type="url"
              maxLength={2048}
              value={baseUrl}
              aria-describedby={`${id}-url-hint`}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
        )}
        <Field label={p.keySet ? "New API key (optional)" : "API key (optional)"}>
          <TextInput
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
        </Field>
      </FormRow>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
        {info.key === "optional" && p.keySet && (
          <Checkbox
            label="Remove the stored key"
            checked={removeKey}
            disabled={newKey !== ""}
            onChange={(e) => setRemoveKey(e.target.checked)}
          />
        )}
        {info.endpoint === "required" && (
          <Checkbox
            label="Allow private network addresses"
            checked={privateNetwork}
            onChange={(e) => setPrivateNetwork(e.target.checked)}
          />
        )}
      </div>
      <p id={`${id}-url-hint`} className="m-0 text-sm text-console-muted">
        {p.keySet
          ? "The stored key is only ever sent to this endpoint. Changing the endpoint needs the API key again."
          : info.hint}
      </p>
      <p id={`${id}-key-hint`} className="m-0 mb-3 text-sm text-console-muted">
        Keys are write-only: the current key is never shown. A new key replaces it.
      </p>
      {needsKey && (
        <Notice tone="warn" role="alert">
          <p>
            You changed the endpoint of a provider with a stored key. Enter the API key again to
            send it to the new endpoint: Kobe never moves a stored key to another address.
          </p>
        </Notice>
      )}
      {insecure && (
        <Notice tone="warn" role="alert">
          <p>
            The server sends API keys over https:// only (unless the operator allowed unsafe
            endpoints for a test site). Use an https:// URL, or remove the key.
          </p>
        </Notice>
      )}
      <Button type="submit" variant="primary" disabled={mutation.pending || needsKey}>
        Save {p.name}
      </Button>
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
    <Section title="Add a provider" level={3}>
      <form onSubmit={onSubmit} aria-label="Add a provider">
        <FormRow className="mt-0">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => chooseKind(e.target.value as ProviderKind)}>
              {PROVIDER_KINDS.map((k) => (
                <option key={k} value={k} disabled={KINDS[k].single && taken.has(k)}>
                  {KINDS[k].label}
                  {KINDS[k].single && taken.has(k) ? " (added)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "openai_compatible" && (
            <Field label="ID">
              <TextInput
                required
                maxLength={32}
                pattern={PROVIDER_ID_PATTERN}
                placeholder="vllm"
                title="Lowercase letters, digits and dashes"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              />
            </Field>
          )}
          <Field label="Name">
            <TextInput
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {info.endpoint === "required" && (
            <Field label="Base URL">
              <TextInput
                required
                type="url"
                maxLength={2048}
                placeholder={info.urlPlaceholder}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </Field>
          )}
          <Field label={info.key === "required" ? "API key" : "API key (optional)"}>
            <TextInput
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              required={info.key === "required"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
        </FormRow>
        {info.endpoint === "required" && (
          <Checkbox
            className="mb-3"
            label="Allow private network addresses"
            checked={privateNetwork}
            onChange={(e) => setPrivateNetwork(e.target.checked)}
          />
        )}
        <p id={`${id}-hint`} className="m-0 mb-3 text-sm text-console-muted">
          {info.hint}
          {info.endpoint === "required" &&
            " Private addresses (a server in your cluster or LAN) also need an egress rule for the gateway in the chart (bifrost.networkPolicy.extraEgress)."}
        </p>
        {insecure && (
          <Notice tone="warn" role="alert">
            <p>
              The server sends API keys over https:// only (unless the operator allowed unsafe
              endpoints for a test site). Use an https:// URL, or leave the key empty.
            </p>
          </Notice>
        )}
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Add provider
        </Button>
      </form>
    </Section>
  );
}
